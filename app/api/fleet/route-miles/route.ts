// POST /api/fleet/route-miles — from and to become miles split by state.
// One Google Routes call gets the drive; the per-state split is computed
// here against bundled state boundaries, so IFTA costs one route lookup.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { computeRouteMiles } from '@/lib/route-miles';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const FLEET_ROLES = ['admin', 'master_admin', 'office', 'driver', 'mechanic', 'labor'];

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles').select('role, hauler_id').eq('id', user.id).single();
  if (!actor || actor.hauler_id || !FLEET_ROLES.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'not allowed' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!from || !to) {
    return NextResponse.json({ ok: false, error: 'give both a from and a to' }, { status: 400 });
  }

  const { data: setting } = await createAdminClient()
    .from('app_settings').select('value').eq('key', 'google_maps_api_key').maybeSingle();
  const apiKey = ((setting as { value: string | null } | null)?.value || '').trim();
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: "Mileage isn't set up yet — the master admin adds the Google Maps key under Work Orders → Setup.",
    }, { status: 400 });
  }

  try {
    const result = await computeRouteMiles(apiKey, from, to);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not get the route.';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
