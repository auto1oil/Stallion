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
  // A hauler may name which of its own units is taking the load. Anything
  // else it posts is ignored.
  if (answer === 'accept' && body.equipment_id) {
    const { data: unit } = await db
      .from('hauler_equipment')
      .select('id')
      .eq('id', String(body.equipment_id))
      .eq('hauler_id', actor.hauler_id)
      .maybeSingle();
    if (unit) patch.equipment_id = unit.id;
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

// Build the haul ticket the hauler will fill out on the job. Everything the
// office already knows is carried across so the driver isn't re-keying it off
// the load they just accepted.
//
// Best-effort by design: if this fails the load is still accepted. A hauler
// looking at an accepted load with no ticket can start one by hand; a hauler
// whose acceptance got rolled back because of a ticket-creation hiccup would
// have no idea why.
async function startHaulTicket(
  db: ReturnType<typeof createAdminClient>,
  load: HaulerLoad,
  userId: string,
  actor: { full_name?: string | null; email?: string | null; hauler_id?: string | null },
): Promise<string | null> {
  try {
    const [{ data: company }, { data: unit }] = await Promise.all([
      db.from('haulers').select('name').eq('id', load.hauler_id).maybeSingle(),
      load.equipment_id
        ? db.from('hauler_equipment').select('unit_number, equipment_type')
            .eq('id', load.equipment_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const { data: wo, error } = await db
      .from('work_orders')
      .insert({
        status: 'draft',
        submitted_by: userId,
        hauler_id: load.hauler_id,
        hauler_load_id: load.id,
        trucking_company: (company as { name: string } | null)?.name ?? null,
        driver_name: actor.full_name || actor.email || null,
        unit_number: (unit as { unit_number: string | null } | null)?.unit_number ?? null,
        equipment_type:
          (unit as { equipment_type: string | null } | null)?.equipment_type ?? load.equipment_type,
        job_number: load.job_number,
        job_name: load.job_name,
        job_address: load.pickup && load.dropoff ? `${load.pickup} → ${load.dropoff}` : (load.pickup || load.dropoff),
        phase_code: load.phase_code,
        job_date: load.job_date,
        rate: load.rate,
        notes: load.notes,
      })
      .select('id')
      .single();
    if (error || !wo) return null;

    await db.from('hauler_loads').update({ work_order_id: wo.id }).eq('id', load.id);
    return wo.id as string;
  } catch {
    return null;
  }
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
