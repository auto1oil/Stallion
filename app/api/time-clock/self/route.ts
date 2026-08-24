// POST /api/time-clock/self — an employee clocks THEMSELVES in/out from their
// phone. Server-validated geofence: the clock is only allowed within an active
// work site's radius, unless the employee is flagged remote. Records the
// coordinates and the matched site on the time_clock row.
//
// Body: { action: 'in' | 'out', lat?: number, lng?: number }

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Site = { id: string; name: string; lat: number; lng: number; radius_m: number };

// Great-circle distance in meters.
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body.action === 'out' ? 'out' : 'in';
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lng = typeof body.lng === 'number' ? body.lng : null;
  const tz = typeof body.tz === 'string' ? body.tz.slice(0, 64) : null;

  const db = createAdminClient();

  // Is this employee allowed to clock from anywhere?
  const { data: prof } = await db.from('profiles').select('remote_clock').eq('id', user.id).maybeSingle();
  const remote = !!(prof as { remote_clock?: boolean } | null)?.remote_clock;

  // Find the nearest active site within its radius (if we have coordinates).
  let matchedSite: Site | null = null;
  let nearest: { site: Site; dist: number } | null = null;
  if (lat != null && lng != null) {
    const { data: sites } = await db.from('work_sites').select('id, name, lat, lng, radius_m').eq('active', true);
    for (const s of (sites as Site[]) || []) {
      const dist = distanceM(lat, lng, s.lat, s.lng);
      if (!nearest || dist < nearest.dist) nearest = { site: s, dist };
      if (dist <= s.radius_m && (!matchedSite || dist < distanceM(lat, lng, matchedSite.lat, matchedSite.lng))) {
        matchedSite = s;
      }
    }
  }

  // Enforce the geofence unless the employee is remote.
  if (!remote && !matchedSite) {
    const nearMsg = nearest
      ? ` Nearest site "${nearest.site.name}" is ${Math.round(nearest.dist)} m away (allowed within ${nearest.site.radius_m} m).`
      : ' No work sites are set up yet.';
    return NextResponse.json(
      { ok: false, error: `You're not at a work site, so you can't clock ${action}.${nearMsg} Ask an admin if this is wrong.` },
      { status: 403 },
    );
  }

  // Longer than any real shift — beyond this, an open session is a forgotten
  // clock-out (it ran into the next day), NOT time actually worked. We refuse to
  // auto-stamp it (that would log a bogus ~all-day total) and make an admin set
  // the true end time instead.
  const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;
  const fmtWhen = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  if (action === 'in') {
    // Prevent a double clock-in.
    const { data: openRow } = await db.from('time_clock')
      .select('id, clock_in_at').eq('employee_id', user.id).is('clock_out_at', null)
      .order('clock_in_at', { ascending: false }).limit(1).maybeSingle();
    if (openRow) {
      const ageMs = Date.now() - new Date((openRow as { clock_in_at: string }).clock_in_at).getTime();
      if (ageMs > MAX_SHIFT_MS) {
        return NextResponse.json({ ok: false, error:
          `You're still clocked in from ${fmtWhen((openRow as { clock_in_at: string }).clock_in_at)} — that shift was never clocked out. An admin has to set the correct end time for it before you can start a new shift. (That day isn't counted until it's fixed.)` }, { status: 409 });
      }
      return NextResponse.json({ ok: false, error: "You're already clocked in." }, { status: 400 });
    }

    const { error } = await db.from('time_clock').insert({
      employee_id: user.id,
      clock_in_lat: lat,
      clock_in_lng: lng,
      clock_in_site_id: matchedSite?.id ?? null,
      clock_in_tz: tz,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action, site: matchedSite?.name ?? (remote ? 'Remote' : null) });
  }

  // action === 'out'
  const { data: open } = await db.from('time_clock')
    .select('id, clock_in_at').eq('employee_id', user.id).is('clock_out_at', null)
    .order('clock_in_at', { ascending: false }).limit(1).maybeSingle();
  if (!open) return NextResponse.json({ ok: false, error: "You're not clocked in." }, { status: 400 });

  // Guard: if this open session started on a prior day (open > a full shift),
  // clocking out now would stamp a wrong, day-long duration. Refuse and route it
  // to an admin, who sets the real end time on the Time Clock board.
  const openInIso = (open as { clock_in_at: string }).clock_in_at;
  const openAgeMs = Date.now() - new Date(openInIso).getTime();
  if (openAgeMs > MAX_SHIFT_MS) {
    const hrs = Math.round(openAgeMs / (60 * 60 * 1000));
    return NextResponse.json({ ok: false, error:
      `Your clock-in from ${fmtWhen(openInIso)} was never clocked out — clocking out now would log about ${hrs} hours by mistake. An admin needs to set the correct end time for that shift on the Time Clock board first. That day isn't counted until it's fixed.` }, { status: 409 });
  }

  const { error } = await db.from('time_clock').update({
    clock_out_at: new Date().toISOString(),
    clock_out_lat: lat,
    clock_out_lng: lng,
    clock_out_site_id: matchedSite?.id ?? null,
    clock_out_tz: tz,
  }).eq('id', (open as { id: string }).id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, action, site: matchedSite?.name ?? (remote ? 'Remote' : null) });
}
