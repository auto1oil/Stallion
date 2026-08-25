// POST /api/haulers/loads/[id]/respond — the hauler answers a load.
//
// A hauler can READ its loads through RLS but never write them, so this route
// is the only way a load's status moves from the hauler's side. It runs as the
// service role and writes exactly two things: the status, and who responded
// when. Everything else on the row — the rate, the job, the dates — stays
// whatever dispatch set, which is the point: a hauler accepting a load must
// not be able to accept it at a different rate.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { sendPushToUsers } from '@/lib/webpush';
import { loadSummary, type HaulerLoad } from '@/lib/haulers';
import { startHaulTicket } from '@/lib/haul-ticket';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A load can only be answered while it is still open. Answering an already
// answered load is a conflict, not a silent overwrite.
const ANSWERABLE = ['offered', 'accepted', 'assigned'];

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles')
    .select('role, hauler_id, full_name, email')
    .eq('id', user.id)
    .single();
  if (!actor || actor.role !== 'hauler' || !actor.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not a hauler login' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const answer = String(body.answer || '');
  if (answer !== 'accept' && answer !== 'decline') {
    return NextResponse.json({ ok: false, error: 'answer must be accept or decline' }, { status: 400 });
  }

  const db = createAdminClient();
  const { data: load } = await db
    .from('hauler_loads')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!load) return NextResponse.json({ ok: false, error: 'load not found' }, { status: 404 });

  // The service role bypasses RLS, so the company check has to be explicit
  // here — this is the line that stops one hauler answering another's load.
  if (load.hauler_id !== actor.hauler_id) {
    return NextResponse.json({ ok: false, error: 'not your load' }, { status: 403 });
  }
  if (!ANSWERABLE.includes(load.status)) {
    return NextResponse.json(
      { ok: false, error: `this load is already ${load.status}` },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = {
    status: answer === 'accept' ? 'accepted' : 'declined',
    responded_by: user.id,
    responded_at: new Date().toISOString(),
    decline_reason: answer === 'decline' ? (String(body.reason || '').trim() || null) : null,
  };
  // A hauler may name which of its own units is taking the load, and which of
  // its own people is driving. Both are checked against the company rather
  // than trusted, and anything else it posts is ignored.
  if (answer === 'accept' && body.equipment_id) {
    const { data: unit } = await db
      .from('hauler_equipment')
      .select('id')
      .eq('id', String(body.equipment_id))
      .eq('hauler_id', actor.hauler_id)
      .maybeSingle();
    if (unit) patch.equipment_id = unit.id;
  }
  if (answer === 'accept') {
    // Defaulting to the accepter is what makes a one-truck outfit work: they
    // take their own load and are already the driver on it.
    const wanted = body.driver_id ? String(body.driver_id) : user.id;
    const { data: person } = await db
      .from('profiles')
      .select('id')
      .eq('id', wanted)
      .eq('hauler_id', actor.hauler_id)
      .maybeSingle();
    patch.driver_id = person ? person.id : user.id;
  }

  const { data: updated, error } = await db
    .from('hauler_loads')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  // Taking a load starts the haul ticket, with everything already known filled
  // in: the company, the truck, the job, the rate. The driver is left with the
  // load lines and the times, which is the only part they actually have to
  // enter on site.
  let workOrderId: string | null = load.work_order_id;
  if (answer === 'accept' && !workOrderId) {
    workOrderId = await startHaulTicket(db, updated as HaulerLoad, user.id, actor);
  }

  await notifyDispatch(
    db,
    updated as HaulerLoad,
    (actor.full_name || actor.email || 'The hauler') as string,
    answer,
  );

  return NextResponse.json({ ok: true, load: updated, work_order_id: workOrderId });
}

// Tell whoever offered the load — and the office generally — what came back.
// Best-effort: the answer stands whether or not the notification lands.
async function notifyDispatch(
  db: ReturnType<typeof createAdminClient>,
  load: HaulerLoad,
  by: string,
  answer: string,
) {
  try {
    const ids = new Set<string>();
    if (load.assigned_by) ids.add(load.assigned_by);
    const { data: staff } = await db
      .from('profiles')
      .select('id')
      .in('role', ['office', 'admin', 'master_admin']);
    for (const p of ((staff as { id: string }[]) || [])) ids.add(p.id);
    const list = [...ids];
    if (list.length === 0) return;

    const summary = loadSummary(load);
    const title = answer === 'accept' ? 'Load accepted' : 'Load declined';
    await db.from('notifications').insert(
      list.map((id) => ({
        recipient_id: id,
        kind: `hauler_load_${answer === 'accept' ? 'accepted' : 'declined'}`,
        title: summary ? `${title} — ${summary}` : title,
        body: load.decline_reason ? `${by}: ${load.decline_reason}` : `${by} responded.`,
        link: `/haulers/${load.hauler_id}`,
      })),
    );
    await sendPushToUsers(list, {
      title,
      body: summary || `${by} responded to a load.`,
      url: `/haulers/${load.hauler_id}`,
    });
  } catch {
    /* ignore */
  }
}
