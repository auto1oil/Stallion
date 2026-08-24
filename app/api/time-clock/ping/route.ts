// POST /api/time-clock/ping — the employee's app reports its current GPS while
// they're clocked in. No-ops (ok:false) if they're not on the clock, so nobody
// off the clock is ever recorded. These breadcrumbs feed the live location +
// after-the-fact trail on the Time Clock board.
//
// Foreground-only by nature: mobile browsers suspend JS (and geolocation) once
// the phone locks or the app is backgrounded, so the trail has gaps whenever
// the app isn't open.
//
// Body: { lat: number, lng: number, accuracy?: number }

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lng = typeof body.lng === 'number' ? body.lng : null;
  const accuracy = typeof body.accuracy === 'number' ? body.accuracy : null;
  if (lat == null || lng == null) {
    return NextResponse.json({ ok: false, error: 'no coordinates' }, { status: 400 });
  }

  const db = createAdminClient();
  // Only record a breadcrumb while the employee actually has an open session.
  const { data: open } = await db.from('time_clock')
    .select('id').eq('employee_id', user.id).is('clock_out_at', null)
    .order('clock_in_at', { ascending: false }).limit(1).maybeSingle();
  if (!open) return NextResponse.json({ ok: false, error: 'not clocked in' });

  const { error } = await db.from('time_clock_pings').insert({
    session_id: (open as { id: string }).id,
    employee_id: user.id,
    lat, lng, accuracy_m: accuracy,
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
