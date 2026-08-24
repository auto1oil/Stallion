// POST /api/trucking/invoice — a driver (or any staff) creates a freight
// invoice: pick a lane + gallons + BOL#, and we bill gallons × the lane's base
// rate, add a fuel-surcharge line (% of the freight), create the QuickBooks
// invoice with the next sequential number, cache its PDF, and drop a dispatch
// row into `orders` so it flows through the normal deliver/sign screens.
//
// Everything money-related is recomputed here from the lane + settings — the
// client only sends lane_id, gallons, and bol_number.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createInvoice, fetchInvoicePdf, attachFileToInvoice } from '@/lib/quickbooks';
import { getTruckingSettings, freightAmount } from '@/lib/trucking';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const STAFF = ['driver', 'mechanic', 'office', 'contractor', 'admin', 'master_admin'];

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role, full_name, email').eq('id', user.id).single();
  if (!actor || !STAFF.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }
  const actorName = (actor.full_name || actor.email || 'Staff') as string;

  type ItemIn = { commodity_id?: string; value?: number | string };
  let body: { customer_id?: string; lane_id?: string; bol_number?: string; bol_path?: string; term_id?: string;
    items?: ItemIn[];
    // legacy single-item shape (still accepted)
    commodity_id?: string; gallons?: number | string; quantity?: number | string; amount?: number | string; } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  if (!body.customer_id) return NextResponse.json({ ok: false, error: 'Pick a customer.' }, { status: 400 });

  // Normalize to a list of { commodity_id, value }.
  const items: { commodity_id: string; value: number }[] = (
    Array.isArray(body.items) && body.items.length
      ? body.items
      : [{ commodity_id: body.commodity_id, value: body.gallons ?? body.quantity ?? body.amount }]
  )
    .filter((i): i is ItemIn & { commodity_id: string } => !!i && !!i.commodity_id)
    .map((i) => ({ commodity_id: i.commodity_id, value: Number(i.value) }));
  if (!items.length) return NextResponse.json({ ok: false, error: 'Pick at least one product.' }, { status: 400 });

  const db = createAdminClient();
  const [{ data: commodityRows }, { data: customer }, settings] = await Promise.all([
    db.from('trucking_commodities').select('id, name, qb_item_id, qb_item_name, qb_item_price, applies_surcharge, pricing_mode, active')
      .in('id', items.map((i) => i.commodity_id)),
    db.from('trucking_customers').select('qb_customer_id, qb_customer_name, active').eq('id', body.customer_id).maybeSingle(),
    getTruckingSettings(),
  ]);
  if (!customer || !customer.active || !customer.qb_customer_id) {
    return NextResponse.json({ ok: false, error: 'That customer isn’t available — reload and try again.' }, { status: 400 });
  }
  const byId = new Map((commodityRows as { id: string }[] | null || []).map((c) => [c.id, c as Record<string, unknown>]));
  const bol = (body.bol_number || '').trim();

  // If any selected product is lane-priced, the whole invoice shares one lane.
  const needsLane = items.some((i) => (byId.get(i.commodity_id)?.pricing_mode ?? 'lane') === 'lane');
  let lane: { origin: string; destination: string; rate_per_gallon: number } | null = null;
  if (needsLane) {
    if (!body.lane_id) return NextResponse.json({ ok: false, error: 'Pick a pickup and destination.' }, { status: 400 });
    const { data } = await db.from('trucking_lanes').select('origin, destination, rate_per_gallon').eq('id', body.lane_id).maybeSingle();
    if (!data) return NextResponse.json({ ok: false, error: 'That lane no longer exists — reload and try again.' }, { status: 400 });
    lane = data as { origin: string; destination: string; rate_per_gallon: number };
  }

  const pct = settings.effectivePct;
  const lines: Array<{ qbItemId: string; qbItemName: string; quantity: number; unitPrice: number; description?: string }> = [];
  let freight = 0;          // total of all freight lines
  let surchargeBase = 0;    // total freight the surcharge applies to
  const noteParts: string[] = [];

  for (const it of items) {
    const c = byId.get(it.commodity_id);
    if (!c || c.active === false || !c.qb_item_id) {
      return NextResponse.json({ ok: false, error: 'A selected product isn’t available — reload and try again.' }, { status: 400 });
    }
    const qbItemId = c.qb_item_id as string;
    const qbItemName = (c.qb_item_name as string) || (c.name as string) || 'Freight';
    const mode = (c.pricing_mode as string) || 'lane';
    const v = it.value;

    if (mode === 'lane') {
      if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ ok: false, error: `Enter the gallons for ${qbItemName}.` }, { status: 400 });
      const rate = Number(lane!.rate_per_gallon);
      const amt = freightAmount(rate, v);
      freight += amt;
      if (c.applies_surcharge !== false) surchargeBase += amt;
      noteParts.push(`${qbItemName} ${v} gal`);
      lines.push({
        qbItemId, qbItemName, quantity: v, unitPrice: rate,
        description: `Orig: ${lane!.origin} · Dest: ${lane!.destination}${bol ? ` · BOL# ${bol}` : ''}`,
      });
    } else if (mode === 'quantity') {
      if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ ok: false, error: `Enter the weight for ${qbItemName}.` }, { status: 400 });
      const unitPrice = c.qb_item_price != null ? Number(c.qb_item_price) : 0;
      freight += freightAmount(unitPrice, v);
      noteParts.push(`${v} × ${qbItemName}`);
      lines.push({ qbItemId, qbItemName, quantity: v, unitPrice, description: bol ? `BOL# ${bol}` : undefined });
    } else { // amount
      if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ ok: false, error: `Enter the rate for ${qbItemName}.` }, { status: 400 });
      const amt = Math.round(v * 100) / 100;
      freight += amt;
      noteParts.push(qbItemName);
      lines.push({ qbItemId, qbItemName, quantity: 1, unitPrice: amt, description: bol ? `BOL# ${bol}` : undefined });
    }
  }

  // One combined fuel-surcharge line on the total surcharge-eligible freight.
  let surcharge = 0;
  if (surchargeBase > 0 && pct > 0) {
    if (!settings.qbSurchargeItemId) {
      return NextResponse.json({ ok: false, error: 'Trucking isn’t set up yet — an admin needs to pick the fuel-surcharge item under Trucking setup.' }, { status: 400 });
    }
    surcharge = freightAmount(pct / 100, surchargeBase);
    lines.push({
      qbItemId: settings.qbSurchargeItemId, qbItemName: settings.qbSurchargeItemName || 'Fuel Surcharge',
      quantity: surchargeBase, unitPrice: Math.round((pct / 100) * 1e5) / 1e5, description: `${pct}%`,
    });
  }

  const noteDetail = `${lane ? `${lane.origin} → ${lane.destination} · ` : ''}${noteParts.join(' + ')}`;

  let invoice;
  try {
    invoice = await createInvoice({
      qbCustomerId: customer.qb_customer_id,
      lines,
      salesTermId: (body.term_id || '').trim() || undefined,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'QuickBooks invoice failed' }, { status: 502 });
  }
  const docNumber = invoice.DocNumber || invoice.Id;

  // Attach the uploaded BOL document to the QuickBooks invoice (best-effort).
  let bolAttachFailed = false;
  if ((body.bol_path || '').trim()) {
    try {
      const { data: blob } = await db.storage.from('invoices').download(body.bol_path!.trim());
      if (!blob) throw new Error('BOL file not found in storage');
      const ext = (body.bol_path!.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
      const typeByExt: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', gif: 'image/gif' };
      const contentType = blob.type || typeByExt[ext] || 'application/octet-stream';
      const fileName = `BOL-${(bol || docNumber).toString().replace(/[^a-z0-9._-]+/gi, '_').slice(0, 40)}.${ext}`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await attachFileToInvoice(invoice.Id, bytes, fileName, contentType);
    } catch (e) { console.warn('BOL attach to QB failed:', e); bolAttachFailed = true; }
  }

  // Dispatch row so it shows in En route + the normal deliver/sign flow.
  const { data: order, error: insErr } = await db.from('orders').insert({
    date: new Date().toISOString().slice(0, 10),
    customer: customer.qb_customer_name || 'Trucking',
    type: 'Trucking',
    invoice_number: docNumber,
    bol_number: bol || null,
    bol_pdf_path: (body.bol_path || '').trim() || null,
    // Trucking freight is already picked up (BOL in hand), so it goes straight
    // to Out for delivery — no warehouse-loading step.
    status: 'out_for_delivery',
    loaded_at: new Date().toISOString(),
    loaded_by: user.id,
    loaded_by_name: actorName,
    notes: `Trucking: ${noteDetail}`,
    created_by: user.id,
    placed_by: user.id,
    placed_by_name: actorName,
    // 'placed' = created in-app (the only values orders_entry_method_check
    // allows besides 'uploaded'); trucking invoices are placed in-app.
    entry_method: 'placed',
  }).select('id').single();
  if (insErr || !order) {
    return NextResponse.json({ ok: true, warning: 'Invoice created in QuickBooks but saving the dispatch row failed: ' + (insErr?.message || 'unknown'), invoice_number: docNumber });
  }

  // Cache the QB PDF under this order.
  let pdfPath: string | null = null;
  try {
    const pdf = await fetchInvoicePdf(invoice.Id);
    pdfPath = `${order.id}/qb-invoice-${docNumber}.pdf`;
    await db.storage.from('invoices').upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
    await db.from('orders').update({ invoice_pdf_path: pdfPath }).eq('id', order.id);
  } catch { /* PDF refresh can be retried from the deliver screen */ }

  return NextResponse.json({
    ok: true,
    order_id: order.id,
    invoice_number: docNumber,
    freight,
    surcharge_pct: surchargeBase > 0 ? pct : 0,
    total: freight + surcharge,
    bol_attach_failed: bolAttachFailed,
  });
}
