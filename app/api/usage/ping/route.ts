// POST /api/usage/ping — the app saying "still open on a screen".
//
// The client pings about once a minute while the tab is visible. Each ping
// within ~2.5 minutes of the previous one adds the real gap to today's
// seconds for that person; a longer gap adds nothing (they were away), it
// just restarts the clock. One row per person per day keeps the table tiny
// forever. Identity comes from the session; writes use the service role —
// there is no client-side write path to fake time through.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A day is a Mountain Time day — the report reads it the same way, so
// "today" means today in Utah, not in Greenwich.
function todayMT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

const MAX_GAP_SECONDS = 150;

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const admin = createAdminClient();
  const day = todayMT();
  const now = new Date();

  const { data: row } = await admin
    .from('usage_days')
    .select('seconds, pings, last_ping_at')
    .eq('user_id', user.id)
    .eq('day', day)
    .maybeSingle();

  if (!row) {
    await admin.from('usage_days').insert({
      user_id: user.id, day, seconds: 0, pings: 1, last_ping_at: now.toISOString(),
    });
    return NextResponse.json({ ok: true });
  }

  const last = row.last_ping_at ? new Date(row.last_ping_at).getTime() : 0;
  const gap = (now.getTime() - last) / 1000;
  const add = gap > 0 && gap <= MAX_GAP_SECONDS ? Math.round(gap) : 0;

  await admin.from('usage_days').update({
    seconds: (row.seconds || 0) + add,
    pings: (row.pings || 0) + 1,
    last_ping_at: now.toISOString(),
  }).eq('user_id', user.id).eq('day', day);

  return NextResponse.json({ ok: true });
}
