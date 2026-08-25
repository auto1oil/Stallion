// ============================================================================
// Orders — the job everything else hangs off.
// ============================================================================
// An order is a specific job: one day, or three months. It carries the agreed
// terms once — customer, job number, phase, rate, FSR, equipment — and every
// haul ticket and every hauler dispatch points at it.
//
// That's what makes an invoice checkable. The order says what was agreed, the
// tickets say what happened, and anything that disagrees is flagged rather
// than quietly billed.
//
// The table is job_orders because public.orders is the delivery board's. In
// the app these are Orders and that one is Tickets.

import type { WorkOrder } from '@/lib/work-orders';

export const ORDER_STATUSES = ['open', 'active', 'complete', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  open: 'Open',
  active: 'Active',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

export const ORDER_STATUS_TONE: Record<OrderStatus, string> = {
  open: 'bg-amber-100 text-amber-900 border-amber-200',
  active: 'bg-blue-100 text-blue-900 border-blue-200',
  complete: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
};

export type JobOrder = {
  id: string;
  order_number: number;
  business_id: string | null;
  customer_number: string | null;
  job_name: string | null;
  job_number: string | null;
  phase_code: string | null;
  job_address: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  stop_time: string | null;
  travel_hours: number | null;
  down_hours: number | null;
  // What the CUSTOMER pays. Office only — haulers cannot read this table.
  rate: number | null;
  // What a hauler is paid on this job by default. Also office only.
  pay_rate: number | null;
  rate_unit: string | null;
  fsr: string | null;
  tonnage: number | null;
  tonnage_type: string | null;
  equipment_type: string | null;
  unit_number: string | null;
  status: OrderStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// What the office may set on an order. order_number is assigned by the
// database and never posted.
export const ORDER_EDITABLE_FIELDS = [
  'business_id', 'customer_number', 'job_name', 'job_number', 'phase_code',
  'job_address', 'start_date', 'end_date', 'start_time', 'stop_time',
  'travel_hours', 'down_hours', 'rate', 'pay_rate', 'rate_unit', 'fsr', 'tonnage',
  'tonnage_type', 'equipment_type', 'unit_number', 'status', 'notes',
] as const;

const ORDER_NUMERIC_FIELDS = new Set([
  'travel_hours', 'down_hours', 'rate', 'pay_rate', 'tonnage',
]);

export function pickOrderEditable(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ORDER_EDITABLE_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === '' || raw === undefined) { out[key] = null; continue; }
    if (raw !== null && ORDER_NUMERIC_FIELDS.has(key)) {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function orderLabel(o: Pick<JobOrder, 'order_number' | 'job_name' | 'job_number'>): string {
  const name = o.job_name || (o.job_number ? `Job ${o.job_number}` : 'Order');
  return `#${o.order_number} · ${name}`;
}

// How long an order runs, in plain words. An order with no dates on it yet is
// still a valid order — it just hasn't been scheduled.
export function orderSpan(o: Pick<JobOrder, 'start_date' | 'end_date'>): string {
  if (!o.start_date && !o.end_date) return 'No dates set';
  if (o.start_date && o.end_date) {
    return o.start_date === o.end_date ? o.start_date : `${o.start_date} → ${o.end_date}`;
  }
  return o.start_date ? `From ${o.start_date}` : `Until ${o.end_date}`;
}

// Whether a date falls inside the order's run. Both ends inclusive; an open
// end means it hasn't finished yet, not that it has.
export function orderCovers(o: Pick<JobOrder, 'start_date' | 'end_date'>, date: string): boolean {
  if (o.start_date && date < o.start_date) return false;
  if (o.end_date && date > o.end_date) return false;
  return true;
}

// The fields a ticket inherits when it's filled against an order. Only the
// ones the order actually carries — an order with no rate shouldn't wipe a
// rate the crew already typed.
export function ticketDefaultsFrom(o: JobOrder, forHauler = false): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== '') out[k] = String(v);
  };
  put('customer_id', o.business_id);
  put('customer_number', o.customer_number);
  put('job_number', o.job_number);
  put('job_name', o.job_name);
  put('job_address', o.job_address);
  put('phase_code', o.phase_code);
  put('fsr', o.fsr);
  // The ticket's rate is what its filer is owed. A hauler's crew is owed the
  // order's pay rate; Stallion's own crew tickets bill at the order's rate.
  put('rate', forHauler ? o.pay_rate : o.rate);

  put('equipment_type', o.equipment_type);
  put('unit_number', o.unit_number);
  put('travel_hours', o.travel_hours);
  put('down_hours', o.down_hours);
  put('tonnage_type', o.tonnage_type);
  return out;
}

// Where a ticket disagrees with the order it was filed against.
//
// Only the things that change what gets billed or who gets paid are compared.
// A crew typing a different unit number is normal — trucks get swapped — and
// flagging it would train the office to ignore the flag, which is worse than
// not having one.
//
// Returns null when the ticket lines up, or a short human-readable list of
// what doesn't. Money is the point, so the rate leads.
export function findMismatch(
  wo: Pick<WorkOrder, 'rate' | 'phase_code' | 'job_number' | 'job_date'> & { hauler_id?: string | null },
  order: Pick<JobOrder, 'rate' | 'pay_rate' | 'phase_code' | 'job_number' | 'start_date' | 'end_date'>,
): string | null {
  const notes: string[] = [];

  // A ticket's rate is what its filer is owed, so it is checked against the
  // matching side of the order: a hauler against the pay rate, Stallion's own
  // crew against the customer rate. Checking a hauler against the customer
  // rate would flag every single ticket with the margin, which is noise.
  const woRate = wo.rate == null ? null : Number(wo.rate);
  const against = wo.hauler_id ? order.pay_rate : order.rate;
  const orderRate = against == null ? null : Number(against);
  if (woRate != null && orderRate != null && woRate !== orderRate) {
    notes.push(`rate $${woRate.toFixed(2)} vs order $${orderRate.toFixed(2)}`);
  }

  const norm = (s: string | null) => (s || '').trim().toLowerCase();
  if (order.phase_code && wo.phase_code && norm(wo.phase_code) !== norm(order.phase_code)) {
    notes.push(`phase ${wo.phase_code} vs order ${order.phase_code}`);
  }
  if (order.job_number && wo.job_number && norm(wo.job_number) !== norm(order.job_number)) {
    notes.push(`job ${wo.job_number} vs order ${order.job_number}`);
  }
  if (wo.job_date && !orderCovers(order, wo.job_date)) {
    notes.push(`worked ${wo.job_date}, outside the order's dates`);
  }

  return notes.length ? notes.join('; ') : null;
}
