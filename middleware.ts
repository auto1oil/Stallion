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
  // Everything behind the sign-in. /home, /login, /reset-password, /no-access
  // and the legal pages stay public.
  //
  // '/hauler' covers '/haulers' too. Both have to be here: this list is what
  // forces the first-login password change, so a path missing from it leaves
  // those people on their temporary password indefinitely.
  const isEmployeePath = path.startsWith('/admin') || path.startsWith('/driver') || path.startsWith('/tickets') || path.startsWith('/work-orders') || path.startsWith('/contractor') || path.startsWith('/funder') || path.startsWith('/hauler') || path.startsWith('/settings') || path.startsWith('/tasks') || path.startsWith('/reminders') || path.startsWith('/messages');

  if (isEmployeePath && !user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (path === '/login' && user) {
    return NextResponse.redirect(new URL('/', request.url));
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
