// ============================================================================
// Fleet — Stallion's own trucks.
// ============================================================================
// Fuel fills and trip miles are logged per state because that's what IFTA
// wants: each quarter, miles run and gallons bought in every state. The
// summary on the fleet board is exactly that table.

export type FleetVehicle = {
  id: string;
  unit_number: string;
  year: string | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  plate: string | null;
  plate_state: string | null;
  registration_expires: string | null;
  insurance_expires: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type FleetFuel = {
  id: string;
  vehicle_id: string;
  filled_on: string;
  odometer: number | null;
  gallons: number | null;
  total_cost: number | null;
  state: string | null;
  vendor: string | null;
  receipt_path: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type FleetTrip = {
  id: string;
  vehicle_id: string;
  trip_date: string;
  from_place: string | null;
  to_place: string | null;
  state: string | null;
  miles: number | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type FleetService = {
  id: string;
  vehicle_id: string;
  service_date: string;
  kind: 'maintenance' | 'repair';
  odometer: number | null;
  description: string | null;
  cost: number | null;
  receipt_path: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type FleetDocument = {
  id: string;
  vehicle_id: string | null;
  label: string;
  file_path: string | null;
  expires_on: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
];

// ---- IFTA quarters ---------------------------------------------------------

// '2026-Q4' for a date; quarters are calendar quarters.
export function quarterOf(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

export function currentQuarter(): string {
  return quarterOf(new Date().toISOString().slice(0, 10));
}

// The last n quarters, newest first, starting at the current one.
export function recentQuarters(n = 8): string[] {
  let [y, q] = currentQuarter().split('-Q').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

export function quarterLabel(quarter: string): string {
  const [y, q] = quarter.split('-Q');
  const months = { '1': 'Jan–Mar', '2': 'Apr–Jun', '3': 'Jul–Sep', '4': 'Oct–Dec' }[q] || '';
  return `Q${q} ${y} (${months})`;
}

// Inclusive date range of a quarter, as YYYY-MM-DD strings for .gte/.lte.
export function quarterRange(quarter: string): { from: string; to: string } {
  const [y, q] = quarter.split('-Q').map(Number);
  const firstMonth = (q - 1) * 3 + 1;
  const lastDay = new Date(y, firstMonth + 2, 0).getDate();
  const mm = (m: number) => String(m).padStart(2, '0');
  return {
    from: `${y}-${mm(firstMonth)}-01`,
    to: `${y}-${mm(firstMonth + 2)}-${mm(lastDay)}`,
  };
}

// Miles and gallons per state for a quarter's rows, states sorted, with a
// total line the caller can print.
export function iftaByState(
  trips: Pick<FleetTrip, 'state' | 'miles'>[],
  fuel: Pick<FleetFuel, 'state' | 'gallons'>[],
): { state: string; miles: number; gallons: number }[] {
  const acc = new Map<string, { miles: number; gallons: number }>();
  const bump = (state: string | null, miles: number, gallons: number) => {
    const key = (state || '??').toUpperCase();
    const row = acc.get(key) || { miles: 0, gallons: 0 };
    row.miles += miles;
    row.gallons += gallons;
    acc.set(key, row);
  };
  for (const t of trips) bump(t.state, Number(t.miles || 0), 0);
  for (const f of fuel) bump(f.state, 0, Number(f.gallons || 0));
  return Array.from(acc.entries())
    .map(([state, v]) => ({ state, miles: Math.round(v.miles * 10) / 10, gallons: Math.round(v.gallons * 1000) / 1000 }))
    .sort((a, b) => a.state.localeCompare(b.state));
}

// ---- Expiry warnings -------------------------------------------------------

// 'expired', 'soon' (within 30 days), or null. Drives the red/amber badges on
// registrations and insurance.
export function expiryState(dateStr: string | null): 'expired' | 'soon' | null {
  if (!dateStr) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr < today) return 'expired';
  const soon = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return dateStr <= soon ? 'soon' : null;
}

export function vehicleLabel(v: Pick<FleetVehicle, 'unit_number' | 'year' | 'make' | 'model'>): string {
  const desc = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return desc ? `Unit ${v.unit_number} · ${desc}` : `Unit ${v.unit_number}`;
}
