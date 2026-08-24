// /api/quickbooks/edit-invoice — admin-only invoice corrections.
//
// GET  ?order_id=<orders.id>   → returns the linked QB invoice's editable
//                                sales-item lines (id, name, qty, unit price).
// POST { order_id, edits }     → applies qty/unitPrice edits to those lines in
//                                QuickBooks (edits the existing invoice in
//                                place), re-downloads the corrected PDF, stores
//                                it, and updates the order. edits is keyed by QB
//                                line Id → { qty?, unitPrice? }.
//
// Works on dispatch `orders` rows that already have a QB invoice_number
// (Out-for-delivery + Delivered). QB stays the source of truth: we pull the
// live invoice, edit its lines, push it back with the right SyncToken.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import {
  getInvoiceByDocNumber, getInvoiceById, updateInvoiceLines, rebuildInvoiceLines,
  fetchInvoicePdf, listAllItems, findItemsByNames, FUEL_TAX_ITEM_NAMES,
  type QBFullInvoice, type DesiredLine,
} from '@/lib/quickbooks';
import type { FuelTier } from '@/lib/fuel-prices';
import { GASOLINE_RE } from '@/lib/fuel-detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Rebuilding lines + recomputing fuel taxes + re-fetching the PDF is several
// QuickBooks round-trips; without a raised limit the request times out and the
// dropped connection surfaces as "Network error saving the invoice".
export const maxDuration = 60;

const FUEL_PRODUCTS = ['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane'] as const;

// Every fuel-tax item name (lowercased), so we can recognize an existing tax
// line and never treat it as a fuel product.
const ALL_FUEL_TAX_NAMES = new Set(
  Object.values(FUEL_TAX_ITEM_NAMES).flat().map((n) => n.toLowerCase()),
);

// QuickBooks returns sub-item names fully-qualified as "Parent:Child" (e.g.
// "Tax:Fed Excise Tax - Clear DSL 1", "GAL:CLEAR DIESEL"). Compare on the bare
// child name so existing tax lines are recognized (and not duplicated) and fuel
// lines are detected regardless of their parent prefix.
function bareName(name: string): string {
  const s = (name || '').toLowerCase().trim();
  const i = s.lastIndexOf(':');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}

// Map a QB invoice line's item name to its fuel-tax category, or null if the
// line isn't a taxable fuel product. Diesel needs both a colour/type word and
// a fuel noun (so "Clear Fuel"/"Clear DSL" match but "clear coat" doesn't);
// gasoline matches on its own distinctive words. Tax lines themselves are
// excluded up front so we don't recurse taxes onto taxes.
function fuelTaxCategory(name: string): keyof typeof FUEL_TAX_ITEM_NAMES | null {
  const n = bareName(name);
  if (!n || ALL_FUEL_TAX_NAMES.has(n)) return null;
  if (/\b(tax|excise|lust|hazard|envir|cleanup|fee|spill)\b/.test(n)) return null;
  if (/dyed/.test(n) && /(dsl|diesel|fuel|gal)/.test(n)) return 'Dyed Fuel';
  if (/clear/.test(n) && /(dsl|diesel|fuel|gal)/.test(n)) return 'Clear Fuel';
  if (GASOLINE_RE.test(n)) return '85-Octane'; // 85/91 share taxes
  return null;
}

// Given the admin's desired lines, strip any fuel-tax lines and re-append the
// correct excise/fee/cleanup lines for each fuel product present. This keeps
// the taxes in lockstep with the fuel quantities and auto-includes them the
// moment Clear Fuel / Dyed Fuel / Gasoline is added — without doubling up when
// an existing fuel invoice is merely adjusted (matching on the bare name so
// QB's "Tax:" parent prefix doesn't defeat the dedup).
async function withFuelTaxes(lines: DesiredLine[]): Promise<DesiredLine[]> {
  const product = lines.filter((l) => !ALL_FUEL_TAX_NAMES.has(bareName(l.qbItemName)));
  const fuelLines = product.filter((l) => fuelTaxCategory(l.qbItemName));
  // No fuel lines → no fuel taxes (any stray tax lines were already stripped).
  if (fuelLines.length === 0) return product;

  const needed = new Set<string>();
  for (const l of fuelLines) for (const t of FUEL_TAX_ITEM_NAMES[fuelTaxCategory(l.qbItemName)!]) needed.add(t);

  let taxItems: Record<string, { Id: string; Name: string; UnitPrice?: number }> = {};
  try { taxItems = await findItemsByNames(Array.from(needed)); } catch { /* fall through */ }

  // Emit each fuel product's taxes directly below its line (not bunched at the
  // bottom), so clear-fuel taxes sit under clear fuel and gasoline taxes under
  // gasoline.
  const out: DesiredLine[] = [];
  for (const l of product) {
    out.push(l);
    const cat = fuelTaxCategory(l.qbItemName);
    if (!cat) continue;
    for (const taxName of FUEL_TAX_ITEM_NAMES[cat]) {
      const ti = taxItems[taxName];
      if (!ti) continue; // tax item missing in QB — skip (matches createInvoice)
      out.push({
        qbItemId: ti.Id,
        qbItemName: ti.Name,
        qty: l.qty,
        unitPrice: typeof ti.UnitPrice === 'number' ? ti.UnitPrice : 0,
        taxLine: true, // sub-cent rate — QB derives it (avoids error 6070)
      });
    }
  }
  return out;
}

// Fuel pricing context for this order: the latest rack base price for each fuel
// product plus the volume tiers (the customer's own when they're on special
// pricing, otherwise the default table) and the special flag. The adjuster uses
// this to price fuel lines as rack + the over-rack markup for the line's
// gallons — the same math the order flow uses — instead of the bare catalog
// price. Base rack price is customer-independent; only the tiers vary by
// customer, so this still returns sensible bases even for invoices with no
// linked customer order.
async function loadFuelPricing(orderId: string): Promise<{
  special: boolean; tiers: FuelTier[]; base: Record<string, number | null>;
}> {
  const db = createAdminClient();

  // Find the customer/business behind this dispatch order (if it came from an
  // in-app customer order) to pick up special pricing + custom tiers.
  let special = false;
  let businessId: string | null = null;
  const { data: co } = await db
    .from('customer_orders').select('customer_id').eq('dispatched_order_id', orderId).maybeSingle();
  if (co?.customer_id) {
    const { data: cust } = await db
      .from('profiles').select('business_id').eq('id', co.customer_id).maybeSingle();
    businessId = cust?.business_id ?? null;
    if (businessId) {
      const { data: biz } = await db
        .from('businesses').select('fuel_special_pricing').eq('id', businessId).maybeSingle();
      special = !!biz?.fuel_special_pricing;
    }
  }

  // Tiers: customer's own when on special pricing (and present), else default.
  let tiers: FuelTier[] = [];
  if (special && businessId) {
    const { data } = await db
      .from('customer_fuel_tiers')
      .select('min_gallons, max_gallons, markup, sort_order')
      .eq('business_id', businessId);
    tiers = (data as FuelTier[]) || [];
  }
  if (tiers.length === 0) {
    const { data } = await db
      .from('fuel_pricing_tiers')
      .select('min_gallons, max_gallons, markup, sort_order');
    tiers = (data as FuelTier[]) || [];
  }

  // Latest rack base price per fuel product, via its rack mapping.
  const { data: maps } = await db
    .from('fuel_price_mappings').select('app_product, rack_location, rack_product');
  const mapByProduct = new Map<string, { rack_location: string; rack_product: string }>();
  for (const m of (maps as { app_product: string; rack_location: string; rack_product: string }[]) || []) {
    mapByProduct.set(m.app_product, { rack_location: m.rack_location, rack_product: m.rack_product });
  }
  const base: Record<string, number | null> = {};
  for (const product of FUEL_PRODUCTS) {
    const mp = mapByProduct.get(product);
    if (!mp) { base[product] = null; continue; }
    const { data: rp } = await db
      .from('rack_prices').select('price')
      .eq('location', mp.rack_location).eq('product', mp.rack_product)
      .order('eff_date', { ascending: false, nullsFirst: false })
      .order('received_at', { ascending: false })
      .limit(1);
    base[product] = rp && rp[0] ? Number((rp[0] as { price: number }).price) : null;
  }

  return { special, tiers, base };
}

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, error: 'not signed in', status: 401 as const, actorName: '' };
  const { data: actor } = await supabase.from('profiles').select('role, full_name, email').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return { supabase, error: 'admin required', status: 403 as const, actorName: '' };
  }
  return { supabase, error: null, status: 200 as const, actorName: (actor.full_name || actor.email || 'Admin') as string };
}

// Pull the order's invoice number, then the live QB invoice.
async function loadInvoiceForOrder(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
): Promise<{ invoice: QBFullInvoice | null; invoiceNumber: string | null; error?: string }> {
  const { data: order } = await supabase
    .from('orders')
    .select('id, invoice_number')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return { invoice: null, invoiceNumber: null, error: 'order not found' };
  if (!order.invoice_number) return { invoice: null, invoiceNumber: null, error: 'This order has no QuickBooks invoice yet.' };
  const invoice = await getInvoiceByDocNumber(order.invoice_number);
  return { invoice, invoiceNumber: order.invoice_number };
}

function editableLines(inv: QBFullInvoice) {
  return (inv.Line || [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail' && l.Id)
    .map((l) => ({
      id: l.Id!,
      qb_item_id: l.SalesItemLineDetail?.ItemRef?.value ?? '',
      name: l.SalesItemLineDetail?.ItemRef?.name || l.Description || 'Item',
      qty: l.SalesItemLineDetail?.Qty ?? 0,
      unit_price: l.SalesItemLineDetail?.UnitPrice ?? 0,
      amount: l.Amount ?? 0,
    }));
}

export async function GET(req: Request) {
  const { supabase, error, status } = await requireAdmin();
  if (error) return NextResponse.json({ ok: false, error }, { status });

  const orderId = new URL(req.url).searchParams.get('order_id');
  if (!orderId) return NextResponse.json({ ok: false, error: 'order_id required' }, { status: 400 });

  try {
    const { invoice, invoiceNumber, error: e } = await loadInvoiceForOrder(supabase, orderId);
    if (e) return NextResponse.json({ ok: false, error: e }, { status: 400 });
    if (!invoice) return NextResponse.json({ ok: false, error: `Invoice #${invoiceNumber} not found in QuickBooks.` }, { status: 404 });
    // Also return the QB item catalog so the editor can change/add products.
    let items: { id: string; name: string; unit_price: number | null }[] = [];
    try {
      items = (await listAllItems()).map((i) => ({ id: i.Id, name: i.Name, unit_price: i.UnitPrice ?? null }));
    } catch { /* picker just won't have options; line edits still work */ }
    // Fuel pricing context so the editor can price fuel as rack + over-rack markup.
    let fuel: { special: boolean; tiers: FuelTier[]; base: Record<string, number | null> } | null = null;
    try { fuel = await loadFuelPricing(orderId); } catch { /* fuel auto-pricing just won't kick in */ }
    // Current sales-tax state: is any sales-item line marked taxable in QB?
    const chargeTax = (invoice.Line || []).some(
      (l) => l.DetailType === 'SalesItemLineDetail'
        && (l.SalesItemLineDetail as { TaxCodeRef?: { value?: string } } | undefined)?.TaxCodeRef?.value === 'TAX',
    );
    return NextResponse.json({ ok: true, invoice_number: invoiceNumber, lines: editableLines(invoice), items, fuel, charge_tax: chargeTax });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'QuickBooks request failed' }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const { supabase, error, status, actorName } = await requireAdmin();
  if (error) return NextResponse.json({ ok: false, error }, { status });

  let body: {
    order_id?: string;
    edits?: Record<string, { qty?: number; unitPrice?: number }>;
    lines?: DesiredLine[];  // full desired set (change/add/delete)
    charge_tax?: boolean;   // add/remove sales tax on the rebuilt invoice
  };
  try { body = await req.json(); } catch { body = {}; }
  const hasLines = Array.isArray(body.lines) && body.lines.length > 0;
  const hasEdits = body.edits && Object.keys(body.edits).length > 0;
  if (!body.order_id || (!hasLines && !hasEdits)) {
    return NextResponse.json({ ok: false, error: 'order_id and lines (or edits) required' }, { status: 400 });
  }

  try {
    const { invoice, invoiceNumber, error: e } = await loadInvoiceForOrder(supabase, body.order_id);
    if (e) return NextResponse.json({ ok: false, error: e }, { status: 400 });
    if (!invoice) return NextResponse.json({ ok: false, error: `Invoice #${invoiceNumber} not found in QuickBooks.` }, { status: 404 });

    // Full rebuild (change/add/delete) when `lines` is given; otherwise the
    // legacy qty/price-only edit path. On a rebuild we recompute fuel taxes so
    // adding Clear Fuel / Dyed Fuel / Gasoline pulls in its excise/fee lines.
    const updated = hasLines
      ? await rebuildInvoiceLines(invoice, await withFuelTaxes(body.lines!), body.charge_tax)
      : await updateInvoiceLines(invoice, body.edits!);

    // Remember the choice on the linked customer order so re-invoicing keeps it.
    if (typeof body.charge_tax === 'boolean') {
      await createAdminClient().from('customer_orders')
        .update({ charge_tax: body.charge_tax }).eq('dispatched_order_id', body.order_id);
    }

    // Re-download the corrected PDF and replace the stored one.
    let pdfPath: string | null = null;
    try {
      const fresh = await getInvoiceById(updated.Id); // ensure latest
      const pdfBytes = await fetchInvoicePdf(updated.Id);
      const docLabel = fresh?.DocNumber || updated.DocNumber || updated.Id;
      pdfPath = `${body.order_id}/qb-invoice-${docLabel}.pdf`;
      await supabase.storage.from('invoices').upload(pdfPath, pdfBytes, {
        contentType: 'application/pdf', upsert: true,
      });
    } catch (pdfErr) {
      // The QB edit succeeded; only the PDF refresh failed. Still record who edited.
      await supabase.from('orders')
        .update({ invoice_edited_by_name: actorName, invoice_edited_at: new Date().toISOString() })
        .eq('id', body.order_id);
      return NextResponse.json({
        ok: true, partial: true,
        warning: 'Invoice updated in QuickBooks, but the PDF refresh failed: ' + (pdfErr instanceof Error ? pdfErr.message : 'unknown'),
        total: updated.TotalAmt ?? null,
      });
    }

    await supabase.from('orders').update({
      invoice_pdf_path: pdfPath,
      invoice_edited_by_name: actorName,
      invoice_edited_at: new Date().toISOString(),
    }).eq('id', body.order_id);

    return NextResponse.json({ ok: true, total: updated.TotalAmt ?? null, invoice_pdf_path: pdfPath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'QuickBooks update failed';
    // 6270: one of the invoice's inventory-tracked (QOH) products has an
    // Inventory Start Date later than the invoice date. The app already retries
    // by moving the invoice to today's date (postInvoiceUpdate); if it still
    // fails, the item's start date is today or later and must be fixed in QB.
    if (/6270|prior to start date/i.test(raw)) {
      return NextResponse.json({ ok: false, error:
        "QuickBooks rejected this: one or more products on the invoice are inventory-tracked "
        + "(quantity on hand), and their Inventory Start Date in QuickBooks is later than the "
        + "invoice date — QB won't sell an inventory item before its start date. The app already "
        + "tried dating the invoice today and QB still refused, so that start date is today or "
        + "later. Fix it in QuickBooks: Products & Services -> open each inventory item on this "
        + "invoice (e.g. the DEF drum, Hydrex AW32 hydraulic, Windshield Wash) -> set its "
        + "inventory \"As of\" / start date to an earlier date (e.g. the start of the year) -> "
        + "Save, then try the adjustment again."
      }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: raw }, { status: 502 });
  }
}
