// GET /api/quickbooks/status — admin-only connection health + LIVE test call.
//
// Reports the stored token's age/expiry and whether the service-role client is
// configured, then makes one real QuickBooks call (CompanyInfo) and returns the
// exact result or error. This gives ground truth in a single click: is it
// connected, which environment, and if it's failing — the precise QB error —
// without needing server logs. Exposes NO token values.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { qbFetch } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  const db = createAdminClient();
  const { data: conn } = await db
    .from('quickbooks_connection')
    .select('realm_id, environment, access_token, refresh_token, access_token_expires_at, updated_at, connected_at')
    .eq('id', 1)
    .maybeSingle();

  const serviceRoleConfigured = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!conn) return NextResponse.json({ ok: true, connected: false, serviceRoleConfigured });

  const now = Date.now();
  const exp = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : null;
  const upd = conn.updated_at ? new Date(conn.updated_at).getTime() : null;
  const mins = (ms: number | null) => (ms == null ? null : Math.round(ms / 60000));

  const { data: lock } = await db
    .from('app_settings').select('value').eq('key', 'qb_refresh_lock').maybeSingle();

  // Recent token-refresh audit trail (JSON in app_settings, newest first) — the
  // sequence that reveals WHY the token was revoked (double-use, non-persisted
  // save, or out-of-band reconnect). No dedicated table / migration needed.
  const { data: logRow } = await db
    .from('app_settings').select('value').eq('key', 'qb_token_log').maybeSingle();
  let events: unknown[] = [];
  try { events = logRow?.value ? JSON.parse(logRow.value) : []; } catch { events = []; }
  if (!Array.isArray(events)) events = [];

  // LIVE test — the decisive bit. Success proves the token is healthy right now.
  let liveTest: { ok: boolean; error?: string } = { ok: false };
  try {
    await qbFetch(`/query?query=${encodeURIComponent('select * from CompanyInfo')}`);
    liveTest = { ok: true };
  } catch (e) {
    liveTest = { ok: false, error: e instanceof Error ? e.message.slice(0, 400) : 'unknown error' };
  }

  return NextResponse.json({
    ok: true,
    connected: !!conn.access_token,
    serviceRoleConfigured,
    environment: conn.environment,
    realm_id: conn.realm_id,
    has_refresh_token: !!conn.refresh_token,
    connected_at: conn.connected_at,
    token_last_saved_at: conn.updated_at,
    token_saved_minutes_ago: upd ? mins(now - upd) : null,
    access_token_expires_at: conn.access_token_expires_at,
    access_token_expires_in_minutes: exp ? mins(exp - now) : null,
    access_token_expired: exp != null ? exp < now : null,
    refresh_lock_held_now: !!lock?.value && new Date(lock.value).getTime() > now,
    live_test: liveTest,
    recent_token_events: events || [],
  });
}
