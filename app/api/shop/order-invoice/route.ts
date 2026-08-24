// GET /api/shop/order-invoice?orderId=… — customer-facing.
//
// Returns the QuickBooks invoice pricing (line unit prices + amounts, subtotal,
// tax, total, balance due) for ONE of the signed-in customer's own orders, so
// they can see what they were charged. Ownership is enforced by reading the
// order with the customer's own session (RLS only returns their orders); the
// QuickBooks lookup then runs server-side. Never exposes cost/margin.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { qbFetch } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

type QBLine = {
  DetailType?: string;
  Amount?: number;
  SalesItemLineDetail?: { ItemRef?: { name?: string }; Qty?: number; UnitPrice?: number };
};

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get('orderId');
  if (!orderId) return NextResponse.json({ ok: false, error: 'orderId required' }, { status: 400 });

  // RLS: this only returns a row if the order belongs to this customer (or their
  // business), so reading it here is the ownership check.
  const { data: order } = await supabase
    .from('customer_orders').select('id, invoice_number').eq('id', orderId).maybeSingle();
  if (!order) return NextResponse.json({ ok: false, error: 'order not found' }, { status: 404 });

  const num = ((order as { invoice_number: string | null }).invoice_number || '').trim();
  if (!num) return NextResponse.json({ ok: true, invoiced: false });

  try {
    const escaped = num.replace(/'/g, "''");
    const res = await qbFetch<{ QueryResponse: { Invoice?: Array<Record<string, unknown>> } }>(
      `/query?query=${encodeURIComponent(`select * from Invoice where DocNumber = '${escaped}'`)}`,
    );
    const inv = res.QueryResponse.Invoice?.[0];
    if (!inv) return NextResponse.json({ ok: true, invoiced: true, found: false });

    const rawLines = (inv.Line as QBLine[]) || [];
    const lines = rawLines
      .filter((l) => l.DetailType === 'SalesItemLineDetail')
      .map((l) => {
        const d = l.SalesItemLineDetail || {};
        return {
          name: (d.ItemRef?.name || '').replace(/^.*:/, '').trim(), // drop QB category prefix
          qty: d.Qty ?? null,
          unitPrice: d.UnitPrice ?? null,
          amount: l.Amount ?? null,
        };
      });
    const subtotal = Math.round(lines.reduce((s, l) => s + Number(l.amount || 0), 0) * 100) / 100;
    const tax = Math.round(Number((inv.TxnTaxDetail as { TotalTax?: number })?.TotalTax ?? 0) * 100) / 100;
    const total = Math.round(Number(inv.TotalAmt ?? subtotal + tax) * 100) / 100;
    const balance = Math.round(Number(inv.Balance ?? 0) * 100) / 100;

    return NextResponse.json({
      ok: true, invoiced: true, found: true,
      docNumber: inv.DocNumber ?? num,
      txnDate: inv.TxnDate ?? null,
      dueDate: inv.DueDate ?? null,
      lines, subtotal, tax, total, balance,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks fetch failed' }, { status: 502 });
  }
}
