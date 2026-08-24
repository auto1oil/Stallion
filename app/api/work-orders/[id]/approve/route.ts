// POST /api/work-orders/[id]/approve — the one place a ticket's status moves.
//
// Body: { as: 'office' | 'contractor' | 'funder', reject?: boolean, reason?: string,
//         invoice?: boolean }
//
// RLS says WHO may write a row; it can't say WHICH columns. So every approval
// comes through here: the caller's role is checked, the row is written with the
// service role, and only that role's own approval columns are set. A contractor
// can never stamp the funder's approval, and nobody can approve their own
// ticket.
//
// Office approval also invoices the customer in QuickBooks (skip with
// invoice: false — e.g. when the office is only clearing the audit and the
// invoice goes out later).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { invoiceWorkOrder, type WorkOrder } from '@/lib/work-orders';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type Role = 'office' | 'contractor' | 'funder';

// Who may stamp which approval. Admins stand in for the office.
const ALLOWED_ROLES: Record<Role, string[]> = {
  office: ['office', 'admin', 'master_admin'],
  contractor: ['contractor', 'admin', 'master_admin'],
  funder: ['funder', 'admin', 'master_admin'],
};

// The statuses a ticket may be in when each approval lands. The contractor's
// sign-off runs alongside the office/funder chain rather than inside it, so it
// accepts anything that has been submitted and isn't finished.
const ALLOWED_FROM: Record<Role, string[]> = {
  office: ['submitted'],
  contractor: ['submitted', 'office_approved', 'funds_approved'],
  funder: ['office_approved'],
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  let body: { as?: Role; reject?: boolean; reason?: string; invoice?: boolean } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const as = body.as;
  if (!as || !(as in ALLOWED_ROLES)) {
    return NextResponse.json({ ok: false, error: 'say which approval this is: office, contractor or funder' }, { status: 400 });
  }

  const { data: actor } = await supabase
    .from('profiles')
    .select('id, role, full_name, email')
    .eq('id', user.id)
    .single();
  if (!actor || !ALLOWED_ROLES[as].includes(actor.role)) {
    return NextResponse.json({ ok: false, error: `only ${as} can do that` }, { status: 403 });
  }

  const db = createAdminClient();
  const { data: existing } = await db
    .from('work_orders')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ ok: false, error: 'work order not found' }, { status: 404 });
  const wo = existing as WorkOrder;

  // A contractor only signs off on their own crews' tickets.
  if (as === 'contractor' && !['admin', 'master_admin'].includes(actor.role) && wo.contractor_id !== user.id) {
    return NextResponse.json({ ok: false, error: 'that ticket belongs to another contractor' }, { status: 403 });
  }
  // Nobody approves a ticket they filled out themselves.
  if (wo.submitted_by === user.id) {
    return NextResponse.json({ ok: false, error: 'you can’t approve your own ticket' }, { status: 403 });
  }

  const now = new Date().toISOString();

  // ---- Rejection: bounce the ticket back with a reason. ----
  if (body.reject === true) {
    const reason = (body.reason || '').trim();
    if (!reason) return NextResponse.json({ ok: false, error: 'give a reason so the crew knows what to fix' }, { status: 400 });
    if (wo.status === 'invoiced') {
      return NextResponse.json({ ok: false, error: 'this ticket is already invoiced — void the invoice in QuickBooks first' }, { status: 400 });
    }
    const { data: updated, error } = await db
      .from('work_orders')
      .update({ status: 'rejected', rejected_reason: reason })
      .eq('id', wo.id)
      .select('*')
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    await notify(db, wo, 'work_order_rejected', 'Ticket sent back', reason);
    return NextResponse.json({ ok: true, work_order: updated });
  }

  if (!ALLOWED_FROM[as].includes(wo.status)) {
    return NextResponse.json({
      ok: false,
      error: `a ${wo.status.replace(/_/g, ' ')} ticket isn’t waiting on the ${as}`,
    }, { status: 400 });
  }

  // ---- Approval: set only this role's own columns. ----
  const patch: Record<string, unknown> = {};
  if (as === 'office') {
    patch.office_approved_by = user.id;
    patch.office_approved_at = now;
    patch.status = 'office_approved';
    patch.rejected_reason = null;
  } else if (as === 'contractor') {
    patch.contractor_approved_by = user.id;
    patch.contractor_approved_at = now;
    // The contractor signs off on their crew's hours; it doesn't move the
    // office/funder chain along.
  } else {
    patch.funder_approved_by = user.id;
    patch.funder_approved_at = now;
    // The office usually invoices at its own approval, before funds are
    // released — so the funder's sign-off is what finishes an
    // already-invoiced ticket.
    patch.status = wo.qb_invoice_id ? 'invoiced' : 'funds_approved';
  }

  const { data: updated, error } = await db
    .from('work_orders')
    .update(patch)
    .eq('id', wo.id)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  // ---- Office approval invoices the customer in QuickBooks. ----
  let invoice: Record<string, unknown> | null = null;
  let invoiceError: string | null = null;
  if (as === 'office' && body.invoice !== false) {
    const result = await invoiceWorkOrder(db, wo.id);
    if (result.body.ok) invoice = result.body;
    // Leave the ticket office-approved when QuickBooks fails — the approval
    // stands and the office can retry the invoice from the ticket screen.
    else invoiceError = String(result.body.error || 'QuickBooks invoice failed');
  }

  await notify(
    db, wo,
    'work_order_approved',
    as === 'funder' ? 'Funds approved' : as === 'contractor' ? 'Contractor approved your ticket' : 'Ticket approved',
    (actor.full_name || actor.email || 'Staff') as string,
  );

  const { data: fresh } = await db.from('work_orders').select('*').eq('id', wo.id).maybeSingle();
  return NextResponse.json({ ok: true, work_order: fresh || updated, invoice, invoice_error: invoiceError });
}

// Tell whoever filled the ticket out what happened to it. Best-effort.
async function notify(
  db: ReturnType<typeof createAdminClient>,
  wo: WorkOrder,
  kind: string,
  title: string,
  detail: string,
) {
  if (!wo.submitted_by) return;
  try {
    await db.from('notifications').insert({
      recipient_id: wo.submitted_by,
      kind,
      title: wo.job_number ? `${title} — job ${wo.job_number}` : title,
      body: detail || null,
      link: `/tickets/${wo.id}`,
    });
  } catch { /* ignore */ }
}
