// Kicks off the QB OAuth flow. Only admins can hit this.
//
//   GET /api/quickbooks/authorize  →  302 to Intuit's consent screen
//
// Intuit will eventually redirect back to /api/quickbooks/callback with
// ?code= ?realmId= ?state=.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { buildAuthorizeUrl } from '@/lib/quickbooks';
import { cookies } from 'next/headers';
import crypto from 'crypto';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', getBase()));

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!profile || (profile.role !== 'admin' && profile.role !== 'master_admin')) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  // CSRF-protect the callback. We stash a random `state` in a cookie and
  // verify it in the callback.
  const state = crypto.randomBytes(16).toString('hex');
  cookies().set('qb_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return NextResponse.redirect(buildAuthorizeUrl(state));
}

function getBase() {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://stallion.vercel.app';
}
