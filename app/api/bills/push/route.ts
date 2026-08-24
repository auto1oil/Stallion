// POST /api/bills/push  — body { id }
//
// Admin only. Takes a reviewed vendor_bills row and posts it to QuickBooks as
// a Bill: matches (or creates) the Vendor by name, builds expense lines from
// line_items (falling back to a single line for the total), and records the
// resulting QB Bill id back on the row (status → 'pushed'). Nothing here runs
// until an admin clicks "Push" — the queue never auto-posts.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { findOrCreateVendor, findDefaultExpenseAccount, createBill, findBillByDocNumber, type BillLine } from '@/lib/quickbooks-bills';
import { findItemsByNames } from '@/lib/quickbooks';

export const runtime = 'nodejs';

type LineItem = {
  description?: string;
  amount?: number;
  qty?: number | null;
  unit_cost?: number | null;
  qb_item_name?: string | null;
  accountId?: string;
};

type Row = {
  id: string;
  status: string;
  vendor_name: string | null;
  vendor_qb_id: string | null;
  invoice_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  memo: string | null;
  line_items: LineItem[] | null;
};

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    let body: { id?: string };
    try { body = (await req.json()) as { id?: string }; } catch { body = {}; }
    if (!body.id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

    const { data: row, error: rErr } = await supabase
      .from('vendor_bills')
      .select('id, status, vendor_name, vendor_qb_id, invoice_number, bill_date, due_date, total_amount, memo, line_items')
      .eq('id', body.id)
      .maybeSingle<Row>();
    if (rErr) return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ ok: false, error: 'bill not found' }, { status: 404 });
    if (row.status === 'pushed') {
      return NextResponse.json({ ok: false, error: 'already pushed to QuickBooks' }, { status: 409 });
    }
    if (!row.vendor_name?.trim()) {
      return NextResponse.json({ ok: false, error: 'vendor name is required before pushing' }, { status: 400 });
    }

    // Build the lines. Each line maps to an inventory item (qb_item_name) so it
    // posts item-based — QuickBooks then counts it toward inventory + COGS.
    const rawLines = (row.line_items || [])
      .filter((l) => Number.isFinite(Number(l.amount)) && Number(l.amount) !== 0);

    // Every line must be mapped to an item before we can post inventory.
    const unmapped = rawLines.filter((l) => !l.qb_item_name);
    if (rawLines.length > 0 && unmapped.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Map every line to an inventory item first — ${unmapped.length} line(s) still unmapped.` },
        { status: 400 },
      );
    }

    // Resolve each mapped item name to its QuickBooks Item id (one batched call).
    const names = Array.from(new Set(rawLines.map((l) => l.qb_item_name!).filter(Boolean)));
    const itemsByName = names.length ? await findItemsByNames(names) : {};
    const missing = names.filter((n) => !itemsByName[n]);
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: `These mapped items aren't in QuickBooks: ${missing.join(', ')}` },
        { status: 400 },
      );
    }

    let lines: BillLine[] = rawLines.map((l) => ({
      description: l.description ?? null,
      amount: Number(l.amount),
      itemId: itemsByName[l.qb_item_name!].Id,
      qty: l.qty ?? null,
      unitCost: l.unit_cost ?? null,
    }));

    // Fallback only when there are no itemized lines at all (e.g. a manually
    // entered bill with just a total): one account-based line for the total.
    if (lines.length === 0) {
      if (!row.total_amount || Number(row.total_amount) <= 0) {
        return NextResponse.json({ ok: false, error: 'no line items and no total amount to post' }, { status: 400 });
      }
      lines = [{ description: row.memo || row.invoice_number || 'Vendor bill', amount: Number(row.total_amount) }];
    }

    const account = await findDefaultExpenseAccount();
    if (!account) {
      return NextResponse.json({ ok: false, error: 'no Expense account found in QuickBooks to post against' }, { status: 400 });
    }

    // Reuse a previously matched vendor id if present, else match/create by name.
    const vendorId = row.vendor_qb_id || (await findOrCreateVendor(row.vendor_name.trim())).Id;

    // Duplicate guard — don't post an invoice that's already in QuickBooks
    // (re-sent or previously hand-keyed). Keyed on vendor + invoice number.
    if (row.invoice_number?.trim()) {
      const existing = await findBillByDocNumber(row.invoice_number.trim(), vendorId);
      if (existing) {
        return NextResponse.json(
          { ok: false, error: `Invoice #${row.invoice_number} is already a Bill in QuickBooks — not pushed again. Reject this one if it's a duplicate.` },
          { status: 409 },
        );
      }
    }

    const bill = await createBill({
      vendorId,
      invoiceNumber: row.invoice_number,
      billDate: row.bill_date,
      dueDate: row.due_date,
      memo: row.memo,
      lines,
      defaultAccountId: account.Id,
    });

    const { error: uErr } = await supabase
      .from('vendor_bills')
      .update({
        status: 'pushed',
        vendor_qb_id: vendorId,
        qb_bill_id: bill.Id,
        qb_doc_number: bill.DocNumber ?? null,
        pushed_at: new Date().toISOString(),
        reviewed_by: user.id,
      })
      .eq('id', row.id);
    if (uErr) {
      // The Bill exists in QB but we failed to record it — surface loudly so it
      // isn't pushed twice.
      return NextResponse.json(
        { ok: false, error: `Bill ${bill.Id} created in QuickBooks but failed to save status: ${uErr.message}`, qbBillId: bill.Id },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, qbBillId: bill.Id, qbDocNumber: bill.DocNumber ?? null });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
