// POST /api/quickbooks/invoice
//
// Body: { customer_order_id: string, fuel_prices?: Record<string, number> }
//
// Looks up (or creates) the QB customer and items for an existing pending
// customer_order, builds an invoice in QuickBooks Online with each
// customer's negotiated pricing, then writes the QB invoice number back
// onto the customer_order row. The heavy lifting lives in
// lib/quickbooks-invoice so the auto-post route can reuse it.
//
// Returns:
//   { ok: true, invoice: { id, docNumber, totalAmt } }
// or:
//   { ok: false, error: '...' }  (with 4xx/5xx)

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { invoiceCustomerOrder } from '@/lib/quickbooks-invoice';

export async function POST(req: Request) {
  const supabase = createClient();

  // 1) Auth — admin only
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  // 2) Parse body
  type ReqBody = {
    customer_order_id?: string;
    /** Per-line price overrides (UnitPrice). Keyed by customer_order_items.id. */
    fuel_prices?: Record<string, number>;
    /** When set, charge (or don't charge) sales tax on this invoice. */
    charge_tax?: boolean;
  };
  let body: ReqBody;
  try { body = (await req.json()) as ReqBody; } catch { body = {}; }
  if (!body.customer_order_id) {
    return NextResponse.json({ ok: false, error: 'customer_order_id required' }, { status: 400 });
  }

  // Persist the sales-tax choice on the order first — invoiceCustomerOrder reads
  // order.charge_tax to mark the QB lines TAX/NON.
  if (typeof body.charge_tax === 'boolean') {
    await supabase.from('customer_orders').update({ charge_tax: body.charge_tax }).eq('id', body.customer_order_id);
  }

  const { status, body: result } = await invoiceCustomerOrder(
    supabase,
    body.customer_order_id,
    body.fuel_prices || {},
  );
  return NextResponse.json(result, { status });
}
