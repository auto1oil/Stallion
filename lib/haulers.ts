// ============================================================================
// Haulers — the hauling companies that run loads for Stallion.
// ============================================================================
// A hauler is a company, not a person. Its people sign in with role 'hauler'
// and a profiles.hauler_id pointing at the company, so every hauler-side query
// is scoped by "same company as me" rather than "rows I created" — a second
// dispatcher at the same company sees the same fleet and the same loads.
//
// Loads are read-only to a hauler. Accept/decline goes through
// /api/haulers/loads/[id]/respond for the same reason ticket approvals go
// through their own route: RLS gates rows, not columns, and a hauler must
// never be able to set its own rate or mark its own load complete.

export const LOAD_STATUSES = [
  'offered',
  'accepted',
  'declined',
  'assigned',
  'completed',
  'cancelled',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export const LOAD_STATUS_LABEL: Record<LoadStatus, string> = {
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  assigned: 'Assigned',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const LOAD_STATUS_TONE: Record<LoadStatus, string> = {
  offered: 'bg-amber-100 text-amber-900 border-amber-200',
  accepted: 'bg-blue-100 text-blue-900 border-blue-200',
  declined: 'bg-red-100 text-red-800 border-red-200',
  assigned: 'bg-indigo-100 text-indigo-900 border-indigo-200',
  completed: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
};

export type Hauler = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  mc_number: string | null;
  dot_number: string | null;
  insurance_expires: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type HaulerEquipment = {
  id: string;
  hauler_id: string;
  unit_number: string | null;
  equipment_type: string | null;
  description: string | null;
  capacity: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type HaulerAvailability = {
  id: string;
  hauler_id: string;
  equipment_id: string | null;
  start_date: string;
  end_date: string;
  status: 'available' | 'blocked';
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type HaulerLoad = {
  id: string;
  hauler_id: string;
  equipment_id: string | null;
  work_order_id: string | null;
  // The job this load is for. A hauler dispatched to an order is how the
  // order gets its trucks, and how the ticket that follows knows its terms.
  order_id: string | null;
  job_number: string | null;
  job_name: string | null;
  phase_code: string | null;
  equipment_type: string | null;
  job_date: string | null;
  start_time: string | null;
  pickup: string | null;
  dropoff: string | null;
  rate: number | null;
  rate_unit: string | null;
  notes: string | null;
  status: LoadStatus;
  assigned_by: string | null;
  responded_by: string | null;
  responded_at: string | null;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
};

// The columns the office may set when offering or editing a load. Status and
// the response stamps are server-owned, the same way a ticket's approval
// columns are.
export const LOAD_EDITABLE_FIELDS = [
  'hauler_id', 'equipment_id', 'work_order_id', 'order_id', 'job_number', 'job_name',
  'phase_code', 'equipment_type', 'job_date', 'start_time', 'pickup',
  'dropoff', 'rate', 'rate_unit', 'notes',
] as const;

const LOAD_NUMERIC_FIELDS = new Set(['rate']);

// Keep only the editable columns from a request body, coercing '' to null so a
// cleared input doesn't try to store an empty string in a numeric/date column.
export function pickLoadEditable(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of LOAD_EDITABLE_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === '' || raw === undefined) { out[key] = null; continue; }
    if (raw !== null && LOAD_NUMERIC_FIELDS.has(key)) {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// A one-line summary of a load, for notification titles and list rows.
export function loadSummary(load: Pick<HaulerLoad,
  'job_number' | 'job_name' | 'job_date' | 'equipment_type' | 'pickup' | 'dropoff'>): string {
  return [
    load.job_number ? `Job ${load.job_number}` : null,
    load.job_name,
    load.job_date,
    load.equipment_type,
    load.pickup && load.dropoff ? `${load.pickup} → ${load.dropoff}` : (load.pickup || load.dropoff),
  ].filter(Boolean).join(' · ');
}

// Does a date fall inside an availability window? Both ends are inclusive —
// "blocked 9th to 14th" means the 14th is blocked too.
export function windowCovers(w: Pick<HaulerAvailability, 'start_date' | 'end_date'>, date: string): boolean {
  return date >= w.start_date && date <= w.end_date;
}

// Whether a unit is free on a given day. A blocked window always wins over an
// available one, so an "available all September" row with a "blocked the 10th
// to the 14th" row on top reads as blocked on the 12th.
export function isFreeOn(
  windows: HaulerAvailability[],
  date: string,
  equipmentId: string | null,
): boolean {
  const relevant = windows.filter(
    (w) => (w.equipment_id === null || w.equipment_id === equipmentId) && windowCovers(w, date),
  );
  return !relevant.some((w) => w.status === 'blocked');
}
