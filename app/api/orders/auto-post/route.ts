// POST /api/orders/auto-post
//
// Body: { customer_order_id: string }
//
// Skips the For-approval queue and posts an order straight to the warehouse:
// it invoices the order in QuickBooks (fuel priced from the volume tiers) and
// creates the warehouse/dispatch row automatically. This applies when:
//   - an admin/master_admin placed the order (an admin submitting IS the
//     approval), regardless of the business flag; or
//   - a salesman/driver placed it for a customer whose business has
//     `auto_invoice_orders` on.
//
// Safe by design:
//   - Only staff callers; role + business flag are re-checked server-side.
//   - If the customer has no linked business, or QB invoicing fails, the order
//     is left pending so it falls into the normal admin approval flow. Nothing
//     is lost.
//
// Returns { ok: true, posted: boolean, reason?, ... }.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { invoiceCustomerOrder } from '@/lib/quickbooks-invoice';
import { tierMarkupForGallons, applyMarkup, type FuelTier } from '@/lib/fuel-prices';

const FUEL_PRODUCT_NAMES = new Set(['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane']);

export async function POST(req: Request) {
  const supabase = createClient();

  // 1) Auth — any staff member
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  const staffRoles = ['salesman', 'driver', 'mechanic', 'admin', 'master_admin'];
  if (!actor || !staffRoles.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }
  const actorIsAdmin = actor.role === 'admin' || actor.role === 'master_admin';

  // 2) Parse body
  let body: { customer_order_id?: string };
  try { body = await req.json(); } catch { body = {}; }
  if (!body.customer_order_id) {
    return NextResponse.json({ ok: false, error: 'customer_order_id required' }, { status: 400 });
  }

  // From here on use the service-role client: staff can't insert dispatch rows
  // or update arbitrary orders under RLS, but we've authorized the caller above
  // and re-check the business flag below.
  const admin = createAdminClient();

  // 3) Load order + customer + business; gate on the auto-invoice flag
  const { data: order, error: orderErr } = await admin
    .from('customer_orders')
    .select('id, status, customer_id, submitted_by_id, delivery_address, notes')
    .eq('id', body.customer_order_id)
    .maybeSingle();
  if (orderErr || !order) {
    return NextResponse.json({ ok: false, error: 'order not found' }, { status: 404 });
  }
  if (order.status !== 'pending') {
    return NextResponse.json({ ok: true, posted: false, reason: `order is ${order.status}` });
  }

  const { data: customer } = await admin
    .from('profiles')
    .select('id, full_name, business_name, email, business_id')
    .eq('id', order.customer_id)
    .single();
  if (!customer?.business_id) {
    return NextResponse.json({ ok: true, posted: false, reason: 'no business linked' });
  }

  const { data: business } = await admin
    .from('businesses')
    .select('id, name, auto_invoice_orders, fuel_special_pricing')
    .eq('id', customer.business_id)
    .single();
  // Admin-placed orders skip approval regardless of the business flag; for
  // salesman/driver placers the business must be flagged for auto-invoice.
  const flagged = !!business?.auto_invoice_orders;
  if (!flagged && !actorIsAdmin) {
    // The customer's *linked* business isn't flagged. This is the usual cause
    // of "it was set to auto but went to approval": the toggle is on for one
    // business record while the customer profile points at another. Echo the
    // business so the placer/admin can spot a mismatch.
    return NextResponse.json({
      ok: true, posted: false, flagged: false,
      reason: 'not flagged for auto-invoice',
      business_id: business?.id ?? null,
    });
  }

  // 4) Load items + compute fuel tier prices to pass as per-line overrides.
  const { data: items } = await admin
    .from('customer_order_items')
    .select('id, product_name, quantity, notes')
    .eq('customer_order_id', order.id);
  const orderItems = items || [];

  const fuelPrices: Record<string, number> = {};
  const fuelItems = orderItems.filter((it) => FUEL_PRODUCT_NAMES.has(it.product_name));
  if (fuelItems.length > 0) {
    const fuelNames = Array.from(new Set(fuelItems.map((it) => it.product_name)));
    const { data: maps } = await admin
      .from('fuel_price_mappings')
      .select('app_product, rack_location, rack_product')
      .in('app_product', fuelNames);

    // Tiers: the customer's own when special pricing is on (and present),
    // otherwise the default table.
    let tiers: FuelTier[] = [];
    if (business.fuel_special_pricing) {
      const { data } = await admin
        .from('customer_fuel_tiers')
        .select('min_gallons, max_gallons, markup, sort_order')
        .eq('business_id', business.id);
      tiers = (data as FuelTier[]) || [];
    }
    if (tiers.length === 0) {
      const { data } = await admin
        .from('fuel_pricing_tiers')
        .select('min_gallons, max_gallons, markup, sort_order');
      tiers = (data as FuelTier[]) || [];
    }

    // Latest rack price per mapped product.
    const rackByProduct = new Map<string, number>();
    for (const mp of (maps as { app_product: string; rack_location: string; rack_product: string }[]) || []) {
      const { data: rp } = await admin
        .from('rack_prices')
        .select('price')
        .eq('location', mp.rack_location)
        .eq('product', mp.rack_product)
        .order('eff_date', { ascending: false, nullsFirst: false })
        .order('received_at', { ascending: false })
        .limit(1);
      const base = rp && rp[0] ? Number((rp[0] as { price: number }).price) : null;
      if (base != null) rackByProduct.set(mp.app_product, base);
    }

    for (const it of fuelItems) {
      const base = rackByProduct.get(it.product_name);
      if (base == null) continue; // no rack → let QB history/default price it
      const markup = tierMarkupForGallons(tiers, it.quantity) ?? 0;
      fuelPrices[it.id] = applyMarkup(base, markup);
    }
  }

  // 5) Invoice in QuickBooks. On any failure, leave the order pending so it
  //    falls into the normal approval flow.
  const inv = await invoiceCustomerOrder(admin, order.id, fuelPrices);
  if (inv.status !== 200 || !inv.body.ok) {
    // Record WHY it didn't auto-post so the admin sees it in the Confirm queue
    // instead of silently having to approve it. Best-effort (column optional).
    await admin.from('customer_orders')
      .update({ auto_post_error: `QuickBooks invoice failed: ${inv.body.error || 'unknown error'}` })
      .eq('id', order.id);
    return NextResponse.json({
      ok: true,
      posted: false,
      flagged,
      reason: 'quickbooks invoice failed — left for approval',
      qb_error: inv.body.error,
    });
  }

  // 6) Create the warehouse/dispatch row.
  // Tie the order to the linked BUSINESS name first (matches the Customers
  // tab + QuickBooks), then fall back to the profile's own fields.
  const customerLabel = business?.name || customer.business_name || customer.full_name || customer.email || 'Customer';
  const itemSummary = orderItems
    .map((it) => `${it.quantity} × ${it.product_name}${it.notes ? ` (${it.notes})` : ''}`)
    .join('\n');
  const noteParts = [
    `From customer order #${order.id.slice(0, 8)} (auto-posted)`,
    `Items:\n${itemSummary}`,
  ];
  if (order.notes) noteParts.push(`Customer notes: ${order.notes}`);
  if (order.delivery_address) noteParts.push(`Deliver to: ${order.delivery_address}`);
  const dispatchType = fuelItems.length > 0 ? 'Fuel' : 'PCMO';

  // Carry the order placer's name onto the dispatch row so "who put this
  // order in" stays visible at every stage. Resolve the submitter if it
  // differs from the customer (e.g. a sales rep ordered on their behalf).
  let placedById: string = order.customer_id;
  let placedByName: string | null = customer.full_name || customer.email || null;
  if (order.submitted_by_id && order.submitted_by_id !== order.customer_id) {
    const { data: sub } = await admin
      .from('profiles')
      .select('full_name, email')
      .eq('id', order.submitted_by_id)
      .single();
    if (sub) {
      placedById = order.submitted_by_id;
      placedByName = sub.full_name || sub.email || placedByName;
    }
  }

  // Insert ONLY guaranteed base columns. Everything that was added by a later
  // migration (placed_by, placed_by_name, entry_method) goes in a best-effort
  // update afterwards — that way a DB that hasn't had the migration applied
  // still gets the warehouse row instead of the whole auto-post silently
  // failing and the order getting stranded in the approval queue.
  const { data: dispatchOrder, error: insErr } = await admin
    .from('orders')
    .insert({
      date: new Date().toISOString().split('T')[0],
      customer: customerLabel,
      type: dispatchType,
      invoice_number: inv.body.invoice_number as string | null,
      invoice_pdf_path: inv.body.invoice_pdf_path as string | null,
      notes: noteParts.join('\n\n'),
      created_by: user.id,
    })
    .select('id')
    .single();

  if (dispatchOrder) {
    await admin
      .from('orders')
      .update({ placed_by: placedById, placed_by_name: placedByName, entry_method: 'placed' })
      .eq('id', dispatchOrder.id);
  }

  if (insErr || !dispatchOrder) {
    // Invoice succeeded but dispatch row failed — the order is already
    // 'invoiced', so it still surfaces in the admin approval/ready list.
    await admin.from('customer_orders')
      .update({ auto_post_error: `Warehouse row failed: ${insErr?.message || 'unknown error'}` })
      .eq('id', order.id);
    return NextResponse.json({
      ok: true,
      posted: false,
      flagged,
      reason: 'invoiced, but warehouse row failed — finish in admin',
      dispatch_error: insErr?.message,
    });
  }

  await admin
    .from('customer_orders')
    .update({
      status: 'dispatched',
      dispatched_order_id: dispatchOrder.id,
      dispatched_at: new Date().toISOString(),
      auto_post_error: null, // posted cleanly — clear any prior failure note
    })
    .eq('id', order.id);

  return NextResponse.json({
    ok: true,
    posted: true,
    flagged,
    invoice_number: inv.body.invoice_number,
    dispatch_order_id: dispatchOrder.id,
  });
}
