'use client';

// The shared filter row for the Orders and Tickets lists: job, hauler,
// driver, how it bills (hourly / tonnage / per load / per day), and a date
// range. Each page owns what "matches" means for its rows; this is just the
// controls and the state shape.

import type { WorkOrder } from '@/lib/work-orders';

export type ListFilter = {
  job: string;      // matches job number or job name
  haulerId: string; // '' = any, 'own' = Stallion's own crews
  driver: string;   // matches the driver's name
  billing: string;  // '' | 'hour' | 'ton' | 'load' | 'day'
  from: string;     // YYYY-MM-DD
  to: string;
};

export const EMPTY_FILTER: ListFilter = {
  job: '', haulerId: '', driver: '', billing: '', from: '', to: '',
};

export function filterActive(f: ListFilter): boolean {
  return !!(f.job || f.haulerId || f.driver || f.billing || f.from || f.to);
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

// How a ticket bills, with the legacy fallback old rows use: tonnage present
// means tons, otherwise hours — same rule the billing math applies.
function ticketBilling(wo: Pick<WorkOrder, 'rate_unit' | 'tonnage' | 'loads_tons'>): string {
  if (wo.rate_unit) return wo.rate_unit;
  return Number(wo.loads_tons || 0) > 0 || Number(wo.tonnage || 0) > 0 ? 'ton' : 'hour';
}

// Does one ticket match the filter? Used by the Tickets list; the Orders page
// has its own predicate because an order's hauler/driver live on its
// dispatches and tickets.
export function matchesTicket(f: ListFilter, wo: WorkOrder): boolean {
  if (f.job) {
    const q = norm(f.job);
    if (!norm(wo.job_number).includes(q) && !norm(wo.job_name).includes(q)) return false;
  }
  if (f.haulerId === 'own') { if (wo.hauler_id) return false; }
  else if (f.haulerId) { if (wo.hauler_id !== f.haulerId) return false; }
  if (f.driver && !norm(wo.driver_name).includes(norm(f.driver))) return false;
  if (f.billing && ticketBilling(wo) !== f.billing) return false;
  if (f.from && (!wo.job_date || wo.job_date < f.from)) return false;
  if (f.to && (!wo.job_date || wo.job_date > f.to)) return false;
  return true;
}

export default function FilterBar({
  value,
  onChange,
  haulers,
  matched,
  total,
}: {
  value: ListFilter;
  onChange: (f: ListFilter) => void;
  haulers: { id: string; name: string }[];
  // "12 of 40" once anything is set, so an empty list reads as filtered-out,
  // not missing.
  matched?: number;
  total?: number;
}) {
  const input = 'px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white';
  const label = 'block text-[11px] font-medium text-gray-600 mb-0.5';
  const set = (k: keyof ListFilter, v: string) => onChange({ ...value, [k]: v });
  const active = filterActive(value);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 mb-4">
      <div className="flex flex-wrap gap-3 items-end">
        <label><span className={label}>Job</span>
          <input value={value.job} onChange={(e) => set('job', e.target.value)}
            placeholder="Number or name" className={`${input} w-36`} />
        </label>
        <label><span className={label}>Hauler</span>
          <select value={value.haulerId} onChange={(e) => set('haulerId', e.target.value)} className={input}>
            <option value="">Any</option>
            <option value="own">Own crews</option>
            {haulers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
        <label><span className={label}>Driver</span>
          <input value={value.driver} onChange={(e) => set('driver', e.target.value)}
            placeholder="Name" className={`${input} w-32`} />
        </label>
        <label><span className={label}>Billing</span>
          <select value={value.billing} onChange={(e) => set('billing', e.target.value)} className={input}>
            <option value="">Any</option>
            <option value="hour">Hourly</option>
            <option value="ton">Tonnage</option>
            <option value="load">Per load</option>
            <option value="day">Per day</option>
          </select>
        </label>
        <label><span className={label}>From</span>
          <input type="date" value={value.from} onChange={(e) => set('from', e.target.value)} className={input} />
        </label>
        <label><span className={label}>To</span>
          <input type="date" value={value.to} min={value.from || undefined}
            onChange={(e) => set('to', e.target.value)} className={input} />
        </label>
        {active && (
          <button
            onClick={() => onChange(EMPTY_FILTER)}
            className="px-3 py-1.5 text-sm text-brand-700 hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      {active && matched !== undefined && total !== undefined && (
        <p className="text-[11px] text-gray-500 mt-2">
          Showing {matched} of {total}.
        </p>
      )}
    </div>
  );
}
