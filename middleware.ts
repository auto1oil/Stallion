import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isEmployeePath = path.startsWith('/admin') || path.startsWith('/driver') || path.startsWith('/salesman') || path.startsWith('/settings') || path.startsWith('/tasks') || path.startsWith('/reminders') || path.startsWith('/messages');
  // The /shop entry points (login + signup) are public; everything else
  // under /shop requires a logged-in customer.
  const isShopAuthedPath = path === '/shop' || path.startsWith('/shop/checkout') || path.startsWith('/shop/account') || path.startsWith('/shop/order') || path.startsWith('/shop/messages');

  if (isEmployeePath && !user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (isShopAuthedPath && !user) {
    return NextResponse.redirect(new URL('/shop/login', request.url));
  }
  if (path === '/login' && user) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }
  if ((path === '/shop/login' || path === '/shop/signup') && user) {
    return NextResponse.redirect(new URL('/shop', request.url));
  }

  // Force password change on first login — employees only. Customers set
  // their own password at signup so they're never in this state.
  if (user && isEmployeePath) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('must_change_password')
      .eq('id', user.id)
      .single();
    if (profile?.must_change_password && path !== '/account') {
      return NextResponse.redirect(new URL('/account', request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
