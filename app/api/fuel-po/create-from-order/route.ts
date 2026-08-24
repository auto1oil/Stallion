// POST /api/fuel-po/create-from-order
//
// Body: { customer_order_id: string }
//
// When a fuel order is placed, auto-create the purchase order(s) for what WE
// owe the fuel supplier: rack + fuel account + gallons, price left blank. The
// buyer fills the price in when the supplier's bill arrives and checks the PO
// off (see /admin/fuel-po).
//
// Safe + idempotent by design:
//   - Reads the loading rack / fuel account straight off each fuel line's notes
//     (that's where the order screen already stores them), so this NEVER touches
//     the order-insert path — a fuel order is created the same whether or not
//     this runs or the fuel-PO tables exist yet.
//   - If POs already exist for the order, it no-ops (won't duplicate on a resend).
//   - One PO per (rack, fuel account); one line per fuel product.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

const FUEL_PRODUCT_NAMES = new Set(['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane']);

// The order screen writes fuel-line notes as:
//   "Loading rack: <rack> · Fuel account: <account>"
// (middle dot U+00B7). Pull the two values back out.
function parseRackAccount(notes: string | null): { rack: string; account: string } | null {
  if (!notes) return null;
  const m = notes.match(/Loading rack:\s*(.+?)\s*·\s*Fuel account:\s*(.+?)\s*$/);
  if (!m) return null;
  const rack = m[1].trim();
  const account = m[2].trim();
  if (!rack || !account) return null;
  return { rack, account };
}

export async function POST(req: Request) {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role, full_name, email').eq('id', user.id).single();
  const staffRoles = ['salesman', 'driver', 'mechanic', 'admin', 'master_admin'];
  if (!actor || !staffRoles.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  let body: { customer_order_id?: string };
  try { body = await req.json(); } catch { body = {}; }
  if (!body.customer_order_id) {
    return NextResponse.json({ ok: false, error: 'customer_order_id required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Idempotent: never create a second batch for the same order.
  const { data: existing } = await admin
    .from('fuel_purchase_orders')
    .select('id')
    .eq('order_id', body.customer_order_id)
    .limit(1);
  if (existing && existing.length > 0) {
    return NextResponse.json({ ok: true, created: 0, reason: 'already exists' });
  }

  const { data: items } = await admin
    .from('customer_order_items')
    .select('product_name, quantity, container_size, notes')
    .eq('customer_order_id', body.customer_order_id);

  const fuelItems = (items || []).filter((it) => FUEL_PRODUCT_NAMES.has(it.product_name));
  if (fuelItems.length === 0) {
    return NextResponse.json({ ok: true, created: 0, reason: 'no fuel lines' });
  }

  // Group fuel lines by (rack, fuel account) — each group becomes one PO.
  const groups = new Map<string, { rack: string; account: string; lines: typeof fuelItems }>();
  for (const it of fuelItems) {
    const ra = parseRackAccount(it.notes);
    if (!ra) continue; // no rack/account captured → can't route a PO; skip.
    // "Inventory" = pulled from our own warehouse stock: no supplier, no bill,
    // so there's nothing to raise a purchase order against.
    if (ra.rack === 'Inventory' || ra.account === 'N/A') continue;
    const key = `${ra.rack}||${ra.account}`;
    if (!groups.has(key)) groups.set(key, { rack: ra.rack, account: ra.account, lines: [] });
    groups.get(key)!.lines.push(it);
  }
  if (groups.size === 0) {
    return NextResponse.json({ ok: true, created: 0, reason: 'no rack/account on fuel lines' });
  }

  const createdByName = actor.full_name || actor.email || null;
  const orderRef = body.customer_order_id.slice(0, 8);
  let created = 0;

  for (const g of groups.values()) {
    const { data: po, error: poErr } = await admin
      .from('fuel_purchase_orders')
      .insert({
        order_id: body.customer_order_id,
        order_ref: orderRef,
        rack: g.rack,
        fuel_account: g.account,
        created_by: user.id,
        created_by_name: createdByName,
      })
      .select('id')
      .single();
    if (poErr || !po) continue; // best-effort (e.g. tables not created yet) — never block the order

    const lines = g.lines.map((it) => ({
      po_id: po.id,
      product_name: it.product_name,
      container_size: it.container_size ?? null,
      gallons: it.quantity,
      unit_price: null,
    }));
    await admin.from('fuel_po_lines').insert(lines);
    created += 1;
  }

  return NextResponse.json({ ok: true, created });
}
