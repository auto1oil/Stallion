'use client';
import { createBrowserClient } from '@supabase/ssr';

// Session-only auth: no Max-Age on the auth cookies, so they die with the
// browser/app and every fresh open is a fresh sign-in. The middleware and
// server client strip the lifetime the same way — all three writers must
// agree or a refresh would quietly make the login persistent again.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: { maxAge: undefined, expires: undefined } }
  );
}
