// POST /api/haulers/loads/[id]/assign — hand a load to one of your drivers.
//
// Separate from accepting because who is driving changes after the fact:
// somebody calls in sick, a truck goes down, the owner takes it himself. The
// ticket follows the reassignment, so the new driver finds it in their own
// list and the old one stops seeing it.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles').select('role, hauler_id').eq('id', user.id).single();
  if (!actor || actor.role !== 'hauler' || !actor.hauler_id) {
    return NextResponse.json(
      { ok: false, error: 'only the company can assign a driver' },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const driverId = String(body.driver_id || '');
  if (!driverId) return NextResponse.json({ ok: false, error: 'pick a driver' }, { status: 400 });

  const db = createAdminClient();

  // Both sides are checked against the caller's own company. The service role
  // bypasses RLS, so neither can be taken on trust.
  const [{ data: load }, { data: driver }] = await Promise.all([
    db.from('hauler_loads').select('id, hauler_id, work_order_id').eq('id', params.id).maybeSingle(),
    db.from('profiles').select('id, full_name, email, hauler_id, active')
      .eq('id', driverId).maybeSingle(),
  ]);
  if (!load || load.hauler_id !== actor.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not your load' }, { status: 403 });
  }
  if (!driver || driver.hauler_id !== actor.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not one of your people' }, { status: 403 });
  }
  if (driver.active === false) {
    return NextResponse.json({ ok: false, error: 'that driver is deactivated' }, { status: 400 });
  }

  await db.from('hauler_loads').update({ driver_id: driver.id }).eq('id', load.id);

  // The ticket carries the assignment too — it is what puts the load in the
  // right person's list, and what the office reads as the driver's name.
  if (load.work_order_id) {
    await db.from('work_orders').update({
      assigned_to: driver.id,
      driver_name: driver.full_name || driver.email || null,
    }).eq('id', load.work_order_id);
  }

  return NextResponse.json({ ok: true, driver_id: driver.id });
}
