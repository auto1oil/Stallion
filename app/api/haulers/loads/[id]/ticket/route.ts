// POST /api/haulers/loads/[id]/ticket — start the haul ticket for a load.
//
// Accepting a load starts its ticket automatically, but that step is
// deliberately best-effort: an acceptance that rolled back because of a ticket
// hiccup would leave the hauler with no idea what happened. This is the way
// back when it didn't land — and the way to get a ticket for a load accepted
// before the automatic step existed.
//
// Idempotent: if the load already has a ticket it hands back the same one
// rather than making a second.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { startHaulTicket } from '@/lib/haul-ticket';
import type { HaulerLoad } from '@/lib/haulers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TAKEN = ['accepted', 'assigned', 'completed'];

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles')
    .select('role, hauler_id, full_name, email')
    .eq('id', user.id)
    .single();
  if (!actor?.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not a hauling company login' }, { status: 403 });
  }

  const db = createAdminClient();
  const { data: load } = await db
    .from('hauler_loads').select('*').eq('id', params.id).maybeSingle();
  if (!load) return NextResponse.json({ ok: false, error: 'load not found' }, { status: 404 });

  // The service role bypasses RLS, so the company check is explicit here.
  if (load.hauler_id !== actor.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not your load' }, { status: 403 });
  }
  if (load.work_order_id) {
    return NextResponse.json({ ok: true, work_order_id: load.work_order_id, existing: true });
  }
  if (!TAKEN.includes(load.status)) {
    return NextResponse.json(
      { ok: false, error: `accept the load first — it is still ${load.status}` },
      { status: 409 },
    );
  }

  const workOrderId = await startHaulTicket(db, load as HaulerLoad, user.id, actor);
  if (!workOrderId) {
    return NextResponse.json({ ok: false, error: 'could not start the ticket' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, work_order_id: workOrderId });
}
