'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { ORDER_STATUSES, ORDER_STATUS_LABEL, type JobOrder } from '@/lib/job-orders';

// Create or edit an order — the job everything else gets tied to.
//
// The fields here are the terms the job was agreed on. Tickets filled against
// this order inherit them, and anything a ticket disagrees with gets flagged,
// so what's typed here is what the invoice is checked against.

type Customer = { id: string; name: string };

const RATE_UNITS = ['hour', 'ton', 'load', 'day'];
const EQUIPMENT_TYPES = [
  'Belly Dump', 'End Dump', 'Side Dump', 'Side Dump Double', 'Super Dump',
  'Water Truck', 'Lowboy', 'Excavator', 'Loader', 'Dozer', 'Blade', 'Skid Steer',
];
const TONNAGE_TYPES = ['', 'Dirt', 'Gravel', 'Asphalt', 'Debris', 'Water', 'Other'];

type Draft = Record<string, string>;

function toDraft(o: JobOrder | null): Draft {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  const today = new Date().toISOString().slice(0, 10);
  return {
    business_id: v(o?.business_id),
    customer_number: v(o?.customer_number),
    job_name: v(o?.job_name),
    job_number: v(o?.job_number),
    phase_code: v(o?.phase_code),
    job_address: v(o?.job_address),
    start_date: v(o?.start_date) || today,
    end_date: v(o?.end_date) || today,
    start_time: v(o?.start_time),
    stop_time: v(o?.stop_time),
    travel_hours: v(o?.travel_hours),
    down_hours: v(o?.down_hours),
    rate: v(o?.rate),
    rate_unit: v(o?.rate_unit) || 'hour',
    fsr: v(o?.fsr),
    tonnage: v(o?.tonnage),
    tonnage_type: v(o?.tonnage_type),
    equipment_type: v(o?.equipment_type),
    unit_number: v(o?.unit_number),
    status: v(o?.status) || 'open',
    notes: v(o?.notes),
  };
}

export default function OrderForm({ order }: { order: JobOrder | null }) {
  const supabase = createClient();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(order));
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const id = order?.id ?? null;
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    supabase.from('businesses').select('id, name').order('name').then(({ data }) => {
      setCustomers((data as Customer[]) || []);
    });
  }, [supabase]);

  async function save() {
    if (!draft.job_name.trim() && !draft.job_number.trim()) {
      setError('Give the order a job name or a job number so it can be told apart.');
      return;
    }
    if (draft.end_date && draft.start_date && draft.end_date < draft.start_date) {
      setError('The end date is before the start date.');
      return;
    }
    setBusy(true); setError(''); setMsg('');

    const num = (x: string) => (x.trim() === '' ? null : Number(x));
    const txt = (x: string) => (x.trim() === '' ? null : x.trim());
    const row = {
      business_id: draft.business_id || null,
      customer_number: txt(draft.customer_number),
      job_name: txt(draft.job_name),
      job_number: txt(draft.job_number),
      phase_code: txt(draft.phase_code),
      job_address: txt(draft.job_address),
      start_date: draft.start_date || null,
      end_date: draft.end_date || null,
      start_time: txt(draft.start_time),
      stop_time: txt(draft.stop_time),
      travel_hours: num(draft.travel_hours),
      down_hours: num(draft.down_hours),
      rate: num(draft.rate),
      rate_unit: draft.rate_unit || null,
      fsr: txt(draft.fsr),
      tonnage: num(draft.tonnage),
      tonnage_type: draft.tonnage_type || null,
      equipment_type: txt(draft.equipment_type),
      unit_number: txt(draft.unit_number),
      status: draft.status,
      notes: txt(draft.notes),
    };

    const { data, error: err } = id
      ? await supabase.from('job_orders').update(row).eq('id', id).select('id').single()
      : await supabase.from('job_orders').insert(row).select('id').single();

    setBusy(false);
    if (err) { setError(err.message); return; }
    setMsg('Saved.');
    router.push(`/work-orders/orders/${data.id}`);
    router.refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const card = 'bg-white border border-gray-200 rounded-lg p-4';

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">The job</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="col-span-2 sm:col-span-3"><span className={label}>Customer</span>
            <select value={draft.business_id} onChange={(e) => set('business_id', e.target.value)} className={input}>
              <option value="">— Pick a customer —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label><span className={label}>Customer #</span>
            <input value={draft.customer_number} onChange={(e) => set('customer_number', e.target.value)} className={input} />
          </label>
          <label className="col-span-1 sm:col-span-2"><span className={label}>Job name</span>
            <input value={draft.job_name} onChange={(e) => set('job_name', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Job #</span>
            <input value={draft.job_number} onChange={(e) => set('job_number', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Phase code</span>
            <input value={draft.phase_code} onChange={(e) => set('phase_code', e.target.value)} className={input} />
          </label>
          <label><span className={label}>FSR</span>
            <input value={draft.fsr} onChange={(e) => set('fsr', e.target.value)} className={input} />
          </label>
          <label className="col-span-2 sm:col-span-3"><span className={label}>Job address</span>
            <input value={draft.job_address} onChange={(e) => set('job_address', e.target.value)} className={input} />
          </label>
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">How long it runs</h2>
        <p className="text-xs text-gray-500 mb-3">
          One day is the same date twice. A three-month job is the same two
          boxes, further apart.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>Starts</span>
            <input
              type="date" value={draft.start_date}
              onChange={(e) => setDraft((d) => ({
                ...d,
                start_date: e.target.value,
                // Keep the range valid while they type rather than erroring later.
                end_date: d.end_date && d.end_date < e.target.value ? e.target.value : d.end_date,
              }))}
              className={input}
            />
          </label>
          <label><span className={label}>Ends</span>
            <input type="date" value={draft.end_date} min={draft.start_date}
              onChange={(e) => set('end_date', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Daily start time</span>
            <input type="time" value={draft.start_time} onChange={(e) => set('start_time', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Daily stop time</span>
            <input type="time" value={draft.stop_time} onChange={(e) => set('stop_time', e.target.value)} className={input} />
          </label>
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Agreed terms</h2>
        <p className="text-xs text-gray-500 mb-3">
          Tickets on this order start from these. Anything a ticket disagrees
          with gets flagged instead of billed quietly.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label><span className={label}>Rate</span>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={draft.rate}
              onChange={(e) => set('rate', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Per</span>
            <select value={draft.rate_unit} onChange={(e) => set('rate_unit', e.target.value)} className={input}>
              {RATE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <label><span className={label}>Travel hours</span>
            <input type="number" step="0.25" min="0" inputMode="decimal" value={draft.travel_hours}
              onChange={(e) => set('travel_hours', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Down time (hrs)</span>
            <input type="number" step="0.25" min="0" inputMode="decimal" value={draft.down_hours}
              onChange={(e) => set('down_hours', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Tonnage (optional)</span>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={draft.tonnage}
              onChange={(e) => set('tonnage', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Tonnage type</span>
            <select value={draft.tonnage_type} onChange={(e) => set('tonnage_type', e.target.value)} className={input}>
              {TONNAGE_TYPES.map((t) => <option key={t} value={t}>{t || '—'}</option>)}
            </select>
          </label>
          <label><span className={label}>Equipment type</span>
            <input value={draft.equipment_type} onChange={(e) => set('equipment_type', e.target.value)}
              className={input} list="order-equipment-types" />
            <datalist id="order-equipment-types">
              {EQUIPMENT_TYPES.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>
          <label><span className={label}>Unit # (truck)</span>
            <input value={draft.unit_number} onChange={(e) => set('unit_number', e.target.value)} className={input} />
          </label>
          <label><span className={label}>Status</span>
            <select value={draft.status} onChange={(e) => set('status', e.target.value)} className={input}>
              {ORDER_STATUSES.map((st) => <option key={st} value={st}>{ORDER_STATUS_LABEL[st]}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className={card}>
        <label><span className={label}>Notes</span>
          <textarea rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} className={input} />
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
        >
          {busy ? 'Saving…' : id ? 'Save order' : 'Create order'}
        </button>
        <button
          onClick={() => router.push('/work-orders/orders')}
          className="px-4 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
