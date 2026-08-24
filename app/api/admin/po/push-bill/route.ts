// POST /api/admin/po/push-bill  { po_id }
//
// Pushes a purchase order into QuickBooks as a Bill (accounts payable). Creates
// the bill the first time; on later calls (after an edit) it UPDATES the same
// bill. Admin-only. Requires a vendor on the PO and a chosen expense account
// (app_settings 'po_expense_account_id', else QB's default expense account).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createBill, updateBill, findOrCreateVendor, findDefaultExpenseAccount } from '@/lib/quickbooks-bills';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  let body: { po_id?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  if (!body.po_id) return NextResponse.json({ ok: false, error: 'po_id required' }, { status: 400 });

  const db = createAdminClient();
  const { data: po } = await db.from('purchase_orders')
    .select('id, po_number, po_date, amount, description, job_invoice, vendor_name, vendor_qb_id, qb_bill_id, canceled_at')
    .eq('id', body.po_id).maybeSingle();
  if (!po) return NextResponse.json({ ok: false, error: 'PO not found' }, { status: 404 });
  if (po.canceled_at) return NextResponse.json({ ok: false, error: 'This PO is canceled — uncancel it before pushing a bill.' }, { status: 400 });
  if (!po.vendor_name && !po.vendor_qb_id) {
    return NextResponse.json({ ok: false, error: 'Pick a vendor on the PO before pushing it to QuickBooks.' }, { status: 400 });
  }
  const amount = Number(po.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ ok: false, error: 'Enter an amount before pushing the PO to QuickBooks.' }, { status: 400 });
  }

  try {
    // Resolve vendor (heal the id back onto the PO).
    let vendorId = po.vendor_qb_id as string | null;
    if (!vendorId) {
      const v = await findOrCreateVendor(po.vendor_name as string, db);
      vendorId = v.Id;
      await db.from('purchase_orders').update({ vendor_qb_id: vendorId, vendor_name: v.DisplayName }).eq('id', po.id);
    }

    // Resolve the expense account (chosen default, else QB's default).
    const { data: acctRow } = await db.from('app_settings').select('value').eq('key', 'po_expense_account_id').maybeSingle();
    let accountId = (acctRow?.value || '').trim();
    if (!accountId) {
      const def = await findDefaultExpenseAccount(db);
      if (!def) return NextResponse.json({ ok: false, error: 'No QuickBooks expense account is set. Pick one under PO settings.' }, { status: 400 });
      accountId = def.Id;
    }

    const lines = [{
      description: (po.description as string) || `PO #${po.po_number}`,
      amount,
      accountId,
    }];
    const opts = {
      vendorId,
      invoiceNumber: (po.job_invoice as string) || `PO-${po.po_number}`,
      billDate: (po.po_date as string) || null,
      memo: `Auto 1 PO #${po.po_number}${po.job_invoice ? ` · ${po.job_invoice}` : ''}`,
      lines,
      defaultAccountId: accountId,
    };

    const bill = po.qb_bill_id
      ? await updateBill(po.qb_bill_id as string, opts, db)
      : await createBill(opts, db);

    await db.from('purchase_orders').update({
      qb_bill_id: bill.Id,
      qb_bill_doc: bill.DocNumber ?? null,
      qb_pushed_at: new Date().toISOString(),
    }).eq('id', po.id);

    return NextResponse.json({ ok: true, bill_id: bill.Id, doc: bill.DocNumber ?? null, updated: !!po.qb_bill_id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks bill failed' }, { status: 502 });
  }
}
