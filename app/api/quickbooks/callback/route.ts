// Intuit redirects here after the user grants access.
//
//   GET /api/quickbooks/callback?code=&realmId=&state=
//
// We exchange the code for a refresh_token and store it in
// public.quickbooks_connection (single-row table).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { exchangeCodeForTokens, logTokenEvent, recordOwnedSuffix } from '@/lib/quickbooks';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const state = url.searchParams.get('state');
  const cookieState = cookies().get('qb_oauth_state')?.value;
  cookies().delete('qb_oauth_state');

  if (!code || !realmId) {
    return NextResponse.redirect(new URL('/admin/quickbooks?error=missing_params', url.origin));
  }
  if (!state || state !== cookieState) {
    return NextResponse.redirect(new URL('/admin/quickbooks?error=state_mismatch', url.origin));
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', url.origin));
  }
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!profile || (profile.role !== 'admin' && profile.role !== 'master_admin')) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (e: any) {
    const msg = encodeURIComponent(e.message || 'token_exchange_failed');
    return NextResponse.redirect(new URL(`/admin/quickbooks?error=${msg}`, url.origin));
  }

  // Default to sandbox since unactivated apps only have sandbox creds.
  // Admin can flip to production later.
  const environment = (process.env.QUICKBOOKS_ENVIRONMENT as 'production' | 'sandbox') || 'sandbox';

  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

  const { error: upErr } = await supabase
    .from('quickbooks_connection')
    .upsert({
      id: 1,
      realm_id: realmId,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      access_token_expires_at: expiresAt.toISOString(),
      environment,
      connected_by: user.id,
      connected_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  if (upErr) {
    const msg = encodeURIComponent(`db_write_failed: ${upErr.message}`);
    return NextResponse.redirect(new URL(`/admin/quickbooks?error=${msg}`, url.origin));
  }

  await recordOwnedSuffix(tokens.refresh_token);
  await logTokenEvent('reconnect', {
    new_suffix: (tokens.refresh_token || '').slice(-6),
    detail: `realm=${realmId} by=${user.id.slice(0, 8)}`,
  });
  return NextResponse.redirect(new URL('/admin/quickbooks?connected=1', url.origin));
}
