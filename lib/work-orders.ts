// ============================================================================
// Field tickets (work orders) — shared types, hour math, and the QuickBooks
// invoice routine the office triggers on approval.
// ============================================================================
// A ticket's money is always recomputed from the row, never trusted from the
// client: worked hours come from start/stop (plus travel + down time), and the
// invoice bills those hours at the ticket's rate. Tonnage-priced jobs bill
// tonnage × rate instead.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice, fetchInvoicePdf } from '@/lib/quickbooks';

export const WORK_ORDER_STATUSES = [
  'draft',
  'submitted',
  'office_approved',
  'funds_approved',
  'invoiced',
  'rejected',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  office_approved: 'Office approved',
  funds_approved: 'Funds approved',
  invoiced: 'Invoiced',
  rejected: 'Rejected',
};

// Tailwind classes per status, so every screen badges a ticket the same way.
export const STATUS_TONE: Record<WorkOrderStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  submitted: 'bg-amber-100 text-amber-900 border-amber-200',
  office_approved: 'bg-blue-100 text-blue-900 border-blue-200',
  funds_approved: 'bg-indigo-100 text-indigo-900 border-indigo-200',
  invoiced: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  rejected: 'bg-red-100 text-red-800 border-red-200',
};

export type WorkOrder = {
  id: string;
  customer_id: string | null;
  business_id: string | null;
  customer_number: string | null;
  job_number: string | null;
  job_name: string | null;
  job_address: string | null;
  driver_name: string | null;
  ticket_number: string | null;
  hauler_id: string | null;
  hauler_load_id: string | null;
  trucking_company: string | null;
  material: string | null;
  supplier: string | null;
  truck_type: string | null;
  truck_type_tons: number | null;
  driver_start_at: string | null;
  driver_end_at: string | null;
  signed_out_state: 'loaded' | 'empty' | null;
  sign_out_at: string | null;
  foreman_signature_path: string | null;
  office_start_haul: string | null;
  office_end_haul: string | null;
  office_travel_hours: number | null;
  office_total_hours: number | null;
  office_comments: string | null;
  // Rolled up off the load lines by a database trigger, so every screen
  // totals a ticket the same way without having to fetch its lines.
  loads_count: number;
  loads_tons: number;
  day_number: string | null;
  phase_code: string | null;
  claim_number: string | null;
  unit_number: string | null;
  equipment_type: string | null;
  fsr: string | null;
  job_date: string | null;
  start_at: string | null;
  stop_at: string | null;
  travel_hours: number | null;
  down_hours: number | null;
  rate: number | null;
  tonnage: number | null;
  tonnage_type: string | null;
  ticket_photo_path: string | null;
  short_ticket_path: string | null;
  signature_path: string | null;
  submitted_by: string | null;
  contractor_id: string | null;
  submitted_at: string | null;
  status: WorkOrderStatus;
  office_approved_by: string | null;
  office_approved_at: string | null;
  contractor_approved_by: string | null;
  contractor_approved_at: string | null;
  funder_approved_by: string | null;
  funder_approved_at: string | null;
  rejected_reason: string | null;
  qb_invoice_id: string | null;
  qb_invoice_number: string | null;
  qb_synced_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// One line off the paper ticket: a single load, its four stamps, and what it
// weighed. Every stamp keeps the GPS fix taken at the same moment — the time
// alone settles nothing when a driver and a foreman remember a day
// differently.
export type WorkOrderLoad = {
  id: string;
  work_order_id: string;
  load_no: number;
  ticket_number: string | null;
  load_in_at: string | null;
  load_in_lat: number | null;
  load_in_lng: number | null;
  load_in_accuracy: number | null;
  load_out_at: string | null;
  load_out_lat: number | null;
  load_out_lng: number | null;
  load_out_accuracy: number | null;
  unload_in_at: string | null;
  unload_in_lat: number | null;
  unload_in_lng: number | null;
  unload_in_accuracy: number | null;
  unload_out_at: string | null;
  unload_out_lat: number | null;
  unload_out_lng: number | null;
  unload_out_accuracy: number | null;
  tons: number | null;
  created_at: string;
  updated_at: string;
};

// The four stamps in the order they happen on a run.
export const LOAD_STAMPS = [
  { key: 'load_in', label: 'Load in' },
  { key: 'load_out', label: 'Load out' },
  { key: 'unload_in', label: 'Unload in' },
  { key: 'unload_out', label: 'Unload out' },
] as const;
export type LoadStampKey = (typeof LOAD_STAMPS)[number]['key'];

// Tons actually hauled, summed off the load lines.
export function totalLoadTons(loads: Pick<WorkOrderLoad, 'tons'>[]): number {
  const sum = loads.reduce((n, l) => n + Number(l.tons || 0), 0);
  return Math.round(sum * 100) / 100;
}

// A load counts once it has been started — an untouched row on a 16-line pad
// is not a load that ran.
export function countLoads(loads: Pick<WorkOrderLoad, 'load_in_at' | 'tons'>[]): number {
  return loads.filter((l) => l.load_in_at || Number(l.tons || 0) > 0).length;
}

// The columns a crew member (or the office) may set on a ticket. Everything
// else — status, the approval stamps, the QuickBooks link — is server-owned.
export const EDITABLE_FIELDS = [
  'customer_id', 'business_id', 'customer_number', 'job_number', 'job_name',
  'job_address', 'day_number', 'phase_code', 'claim_number', 'unit_number',
  'equipment_type', 'fsr', 'job_date', 'driver_name', 'ticket_number',
  'hauler_id', 'hauler_load_id', 'trucking_company', 'material', 'supplier',
  'truck_type', 'truck_type_tons', 'driver_start_at', 'driver_end_at',
  'signed_out_state', 'sign_out_at', 'foreman_signature_path',
  'start_at', 'stop_at', 'travel_hours', 'down_hours', 'rate',
  'tonnage', 'tonnage_type', 'ticket_photo_path', 'short_ticket_path',
  'signature_path', 'contractor_id', 'notes',
] as const;

const NUMERIC_FIELDS = new Set([
  'travel_hours', 'down_hours', 'rate', 'tonnage', 'truck_type_tons',
  'office_travel_hours', 'office_total_hours',
]);

// Keep only the editable columns from a request body, coercing '' to null so a
// cleared input doesn't try to store an empty string in a numeric/date column.
export function pickEditable(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === '' || raw === undefined) { out[key] = null; continue; }
    if (raw !== null && NUMERIC_FIELDS.has(key)) {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// Hours between clock-in and clock-out, to two decimals. Same math as the time
// clock: absolute instants, so a shift crossing midnight (or a timezone line)
// still measures right.
export function onSiteHours(startAt: string | null, stopAt: string | null): number {
  if (!startAt || !stopAt) return 0;
  const ms = new Date(stopAt).getTime() - new Date(startAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

// Total billable hours: on-site + travel + down time.
export function totalHours(wo: Pick<WorkOrder, 'start_at' | 'stop_at' | 'travel_hours' | 'down_hours'>): number {
  const sum = onSiteHours(wo.start_at, wo.stop_at)
    + Number(wo.travel_hours || 0)
    + Number(wo.down_hours || 0);
  return Math.round(sum * 100) / 100;
}

// What the ticket bills. Tonnage jobs bill tonnage × rate; everything else
// bills hours × rate.
export function ticketAmount(wo: Pick<WorkOrder,
  'start_at' | 'stop_at' | 'travel_hours' | 'down_hours' | 'rate' | 'tonnage' | 'tonnage_type'>
  & { loads_tons?: number | null },
  loads?: Pick<WorkOrderLoad, 'tons'>[]): number {
  const rate = Number(wo.rate || 0);
  const qty = billableQuantity(wo, loads);
  return Math.round(rate * qty * 100) / 100;
}

// The tonnage a ticket bills. The load lines are the record when they carry
// weights — that's what the scale house handed over, line by line — and the
// header tonnage is the fallback for a ticket filled out without them.
//
// Callers that already hold the lines (the form, mid-edit) pass them; everyone
// else reads loads_tons off the row, which the trigger keeps in step. Both
// routes land on the same number, which is the point.
export function effectiveTonnage(
  wo: Pick<WorkOrder, 'tonnage'> & { loads_tons?: number | null },
  loads?: Pick<WorkOrderLoad, 'tons'>[],
): number {
  const fromLines = loads ? totalLoadTons(loads) : Number(wo.loads_tons || 0);
  return fromLines > 0 ? fromLines : Number(wo.tonnage || 0);
}

// The quantity the rate applies to, and its unit — hours unless the ticket
// carries tonnage, in which case the tonnage is what's billed.
export function billableQuantity(wo: Pick<WorkOrder,
  'start_at' | 'stop_at' | 'travel_hours' | 'down_hours' | 'tonnage'>
  & { loads_tons?: number | null },
  loads?: Pick<WorkOrderLoad, 'tons'>[]): number {
  const tons = effectiveTonnage(wo, loads);
  return tons > 0 ? tons : totalHours(wo);
}

export function billableUnit(
  wo: Pick<WorkOrder, 'tonnage' | 'tonnage_type'> & { loads_tons?: number | null },
  loads?: Pick<WorkOrderLoad, 'tons'>[],
): string {
  return effectiveTonnage(wo, loads) > 0 ? (wo.tonnage_type || 'tons') : 'hrs';
}

// A one-line summary of the job for the invoice line's description.
export function ticketDescription(wo: WorkOrder): string {
  return [
    wo.job_number ? `Job ${wo.job_number}` : null,
    wo.job_name || null,
    wo.day_number ? `Day ${wo.day_number}` : null,
    wo.phase_code ? `Phase ${wo.phase_code}` : null,
    wo.unit_number ? `Unit ${wo.unit_number}` : null,
    wo.equipment_type || null,
    wo.claim_number ? `Claim ${wo.claim_number}` : null,
    wo.fsr ? `FSR ${wo.fsr}` : null,
    wo.job_date,
  ].filter(Boolean).join(' · ');
}

export type InvoiceOutcome = { status: number; body: Record<string, unknown> };

// The QuickBooks item every work-order invoice line bills against. An admin
// picks it once on the Work Orders setup screen.
export async function getWorkOrderQbItem(db: SupabaseClient): Promise<{ id: string; name: string } | null> {
  const { data } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', ['work_order_qb_item_id', 'work_order_qb_item_name']);
  const m = new Map(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
  const id = (m.get('work_order_qb_item_id') || '').trim();
  if (!id) return null;
  return { id, name: (m.get('work_order_qb_item_name') || '').trim() || 'Labor' };
}

// Invoice one approved ticket to its customer in QuickBooks, then stamp the
// invoice id/number back onto the row. Runs with whatever client the caller
// passes (the approve route passes the service-role client).
export async function invoiceWorkOrder(db: SupabaseClient, workOrderId: string): Promise<InvoiceOutcome> {
  const { data: wo } = await db
    .from('work_orders')
    .select('*')
    .eq('id', workOrderId)
    .maybeSingle();
  if (!wo) return { status: 404, body: { ok: false, error: 'work order not found' } };
  const order = wo as WorkOrder;

  if (order.qb_invoice_id) {
    return { status: 400, body: { ok: false, error: `already invoiced (#${order.qb_invoice_number || order.qb_invoice_id})` } };
  }

  // The load lines are the record of what was hauled, so the billable
  // quantity is recomputed from them here rather than trusting whatever
  // tonnage total the ticket was saved with.
  const { data: loadRows } = await db
    .from('work_order_loads')
    .select('tons')
    .eq('work_order_id', workOrderId);
  const loads = (loadRows as Pick<WorkOrderLoad, 'tons'>[]) || [];

  const qty = billableQuantity(order, loads);
  const rate = Number(order.rate || 0);
  if (qty <= 0) return { status: 400, body: { ok: false, error: 'nothing to bill — enter the start/stop times or tonnage first' } };
  if (rate <= 0) return { status: 400, body: { ok: false, error: 'enter a rate before invoicing' } };

  // Resolve the QuickBooks customer: the linked business first (several
  // profiles can share one), then the customer profile's own mapping.
  let qbCustomerId: string | null = null;
  if (order.business_id) {
    const { data: biz } = await db
      .from('businesses')
      .select('qb_customer_id')
      .eq('id', order.business_id)
      .maybeSingle();
    qbCustomerId = (biz as { qb_customer_id: string | null } | null)?.qb_customer_id ?? null;
  }
  if (!qbCustomerId && order.customer_id) {
    const { data: map } = await db
      .from('customer_qb_mapping')
      .select('qb_customer_id')
      .eq('profile_id', order.customer_id)
      .maybeSingle();
    qbCustomerId = (map as { qb_customer_id: string | null } | null)?.qb_customer_id ?? null;
  }
  if (!qbCustomerId) {
    return { status: 400, body: { ok: false, error: 'this customer isn’t linked to QuickBooks yet — link them on the Customers tab first' } };
  }

  const item = await getWorkOrderQbItem(db);
  if (!item) {
    return { status: 400, body: { ok: false, error: 'no QuickBooks item is set for work orders — an admin needs to pick one under Work Orders setup' } };
  }

  let invoice;
  try {
    invoice = await createInvoice({
      qbCustomerId,
      lines: [{
        qbItemId: item.id,
        qbItemName: item.name,
        quantity: qty,
        unitPrice: rate,
        description: ticketDescription(order),
      }],
      customerMemo: order.notes || undefined,
      poNumber: order.job_number || undefined,
    });
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, error: err instanceof Error ? err.message : 'QuickBooks invoice failed' },
    };
  }

  // The office invoices as soon as it approves, which is usually BEFORE the
  // funder has released funds — so raising the invoice doesn't by itself
  // finish the chain. A ticket only becomes 'invoiced' once both have
  // happened; until the funder signs off it stays 'office_approved' and keeps
  // showing up on their queue.
  const docNumber = invoice.DocNumber || invoice.Id;
  await db.from('work_orders').update({
    status: order.funder_approved_at ? 'invoiced' : order.status,
    qb_invoice_id: invoice.Id,
    qb_invoice_number: docNumber,
    qb_synced_at: new Date().toISOString(),
  }).eq('id', order.id);

  // Cache the PDF next to the ticket so the office can hand it over without a
  // second QuickBooks round-trip. Best-effort — the invoice itself is done.
  let pdfPath: string | null = null;
  try {
    const pdf = await fetchInvoicePdf(invoice.Id);
    pdfPath = `work-orders/${order.id}/invoice-${docNumber}.pdf`;
    await db.storage.from('invoices').upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true });
  } catch { pdfPath = null; }

  return {
    status: 200,
    body: {
      ok: true,
      invoice_id: invoice.Id,
      invoice_number: docNumber,
      amount: Math.round(qty * rate * 100) / 100,
      pdf_path: pdfPath,
    },
  };
}
