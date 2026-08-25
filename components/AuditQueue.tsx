'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import {
  totalHours, ticketAmount, onSiteHours, billableUnit, billableQuantity,
  type WorkOrder,
} from '@/lib/work-orders';

// The audit queue.
//
// The point is not to open every ticket. A ticket filed against an order, with
// nothing disagreeing with it, has already been checked by the machine — the
// rate, the phase, the job and the dates all line up. Those go in a list you
// can tick and pass in one go.
//
// Anything the machine can't vouch for goes up top with the reason: it
// disagrees with its order, or it has no order to be checked against, or it
// has nothing to bill. Those are the ones worth a person's time.

type Column = { key: string; label: string; get: (w: WorkOrder) => string };

// Everything the office can choose to see at a glance. Deliberately more than
// anyone needs at once — the chooser is how it gets cut down.
const COLUMNS: Column[] = [
  { key: 'job_date', label: 'Date', get: (w) => w.job_date || '' },
  { key: 'order', label: 'Order', get: (w) => (w.order_id ? 'yes' : '—') },
  { key: 'job_number', label: 'Job #', get: (w) => w.job_number || '' },
  { key: 'job_name', label: 'Job name', get: (w) => w.job_name || '' },
  { key: 'phase_code', label: 'Phase', get: (w) => w.phase_code || '' },
  { key: 'driver_name', label: 'Driver', get: (w) => w.driver_name || '' },
  { key: 'trucking_company', label: 'Company', get: (w) => w.trucking_company || '' },
  { key: 'unit_number', label: 'Unit #', get: (w) => w.unit_number || '' },
  { key: 'equipment_type', label: 'Equipment', get: (w) => w.equipment_type || '' },
  { key: 'truck_type', label: 'Truck type', get: (w) => w.truck_type || '' },
  { key: 'material', label: 'Material', get: (w) => w.material || '' },
  { key: 'supplier', label: 'Supplier', get: (w) => w.supplier || '' },
  { key: 'fsr', label: 'FSR', get: (w) => w.fsr || '' },
  { key: 'ticket_number', label: 'Ticket #', get: (w) => w.ticket_number || '' },
  { key: 'on_site', label: 'On site', get: (w) => onSiteHours(w.start_at, w.stop_at).toFixed(2) },
  { key: 'travel_hours', label: 'Travel', get: (w) => (w.travel_hours == null ? '' : Number(w.travel_hours).toFixed(2)) },
  { key: 'down_hours', label: 'Down', get: (w) => (w.down_hours == null ? '' : Number(w.down_hours).toFixed(2)) },
  { key: 'total_hours', label: 'Hours', get: (w) => totalHours(w).toFixed(2) },
  { key: 'loads_count', label: 'Loads', get: (w) => String(w.loads_count ?? 0) },
  { key: 'loads_tons', label: 'Tons', get: (w) => Number(w.loads_tons || 0).toFixed(2) },
  { key: 'rate', label: 'Rate', get: (w) => (w.rate == null ? '' : `$${Number(w.rate).toFixed(2)}`) },
  { key: 'bills', label: 'Bills', get: (w) => `${billableQuantity(w).toFixed(2)} ${billableUnit(w)}` },
  { key: 'amount', label: 'Amount', get: (w) => `$${ticketAmount(w).toFixed(2)}` },
  { key: 'photo', label: 'Photo', get: (w) => (w.ticket_photo_path ? 'yes' : 'MISSING') },
];

const DEFAULT_KEYS = ['job_date', 'driver_name', 'trucking_company', 'unit_number',
  'loads_count', 'loads_tons', 'total_hours', 'amount'];

// Why a ticket can't be passed without someone looking. Null means it can.
function needsEyes(w: WorkOrder): string | null {
  if (w.order_mismatch && !w.mismatch_cleared_at) return w.order_mismatch;
  if (!w.order_id) return 'no order — nothing to check it against';
  if (!w.ticket_photo_path) return 'no photo of the paper ticket';
  if (ticketAmount(w) <= 0) return 'nothing to bill — no hours, no tonnage, or no rate';
  return null;
}

export default function AuditQueue() {
  const supabase = createClient();
  const [rows, setRows] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<string[]>(DEFAULT_KEYS);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [{ data: tickets }, { data: setting }] = await Promise.all([
      supabase.from('work_orders').select('*').eq('status', 'submitted')
        .order('job_date', { ascending: true, nullsFirst: false }),
      supabase.from('app_settings').select('value').eq('key', 'audit_fields').maybeSingle(),
    ]);
    setRows((tickets as WorkOrder[]) || []);
    const saved = (setting as { value: string } | null)?.value;
    if (saved) setKeys(saved.split(',').map((k) => k.trim()).filter(Boolean));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function saveKeys(next: string[]) {
    setKeys(next);
    await supabase.from('app_settings')
      .upsert([{ key: 'audit_fields', value: next.join(',') }], { onConflict: 'key' });
  }

  // Approvals go one at a time through the same route a single approval uses,
  // so a bulk pass is exactly N normal approvals — each one re-checked by the
  // server, each one raising its own QuickBooks invoice. A failure part-way
  // leaves the ones before it approved, which is right: they were fine.
  async function approveSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true); setErrors([]); setProgress('');
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      setProgress(`Approving ${i + 1} of ${ids.length}…`);
      try {
        const res = await fetch(`/api/work-orders/${ids[i]}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ as: 'office' }),
        });
        const json = await res.json();
        if (!json.ok) failed.push(`${shortName(ids[i])}: ${json.error || 'failed'}`);
        else if (json.invoice_error) failed.push(`${shortName(ids[i])}: approved, but QuickBooks said ${json.invoice_error}`);
      } catch {
        failed.push(`${shortName(ids[i])}: network error`);
      }
    }
    setBusy(false); setProgress('');
    setErrors(failed);
    setSelected(new Set());
    refresh();
  }

  function shortName(id: string) {
    const w = rows.find((r) => r.id === id);
    return w?.job_number ? `Job ${w.job_number}` : (w?.job_date || id.slice(0, 8));
  }

  const shown = COLUMNS.filter((c) => keys.includes(c.key));
  const flagged = rows.filter((w) => needsEyes(w) !== null);
  const clean = rows.filter((w) => needsEyes(w) === null);
  const cleanTotal = clean.reduce((n, w) => n + ticketAmount(w), 0);
  const selectedTotal = clean
    .filter((w) => selected.has(w.id))
    .reduce((n, w) => n + ticketAmount(w), 0);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-gray-600">
          {rows.length === 0
            ? 'Nothing waiting — the queue is clear.'
            : `${flagged.length} need a look · ${clean.length} check out clean`}
        </p>
        <button
          onClick={() => setPicking((v) => !v)}
          className="text-sm text-brand-700 hover:underline"
        >
          {picking ? 'Done choosing' : 'Choose fields'}
        </button>
      </div>

      {picking && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-2">
            Tick what you want in front of you. Saved for everyone in the office.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {COLUMNS.map((c) => {
              const on = keys.includes(c.key);
              return (
                <button
                  key={c.key}
                  onClick={() => saveKeys(on ? keys.filter((k) => k !== c.key) : [...keys, c.key])}
                  className={`px-2.5 py-1 text-xs rounded-full border ${
                    on
                      ? 'bg-brand-700 text-white border-brand-700 font-medium'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => saveKeys(DEFAULT_KEYS)}
            className="mt-3 text-xs text-brand-700 hover:underline"
          >
            Back to the default set
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>Some didn&apos;t go through:</strong>
          <ul className="list-disc ml-5 mt-1">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}

      {/* ---- Needs a look ---- */}
      {flagged.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Needs a look — {flagged.length}
          </h2>
          <div className="space-y-2">
            {flagged.map((w) => (
              <div key={w.id} className="rounded-lg border border-red-300 bg-red-50 px-4 py-3">
                <div className="flex justify-between items-start gap-3 flex-wrap">
                  <Link href={`/work-orders/${w.id}`} className="font-medium text-sm hover:text-brand-700">
                    {w.job_number ? `Job ${w.job_number}` : 'Ticket'}
                    {w.job_date ? ` · ${w.job_date}` : ''}
                    {w.driver_name ? ` · ${w.driver_name}` : ''}
                  </Link>
                  <span className="text-sm font-semibold shrink-0">${ticketAmount(w).toFixed(2)}</span>
                </div>
                <p className="text-xs text-red-700 font-medium mt-1">{needsEyes(w)}</p>
                <div className="text-xs text-gray-600 mt-1">
                  {shown.map((c) => `${c.label} ${c.get(w) || '—'}`).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Clean ---- */}
      {clean.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Checks out — {clean.length} · ${cleanTotal.toFixed(2)}
            </h2>
            <div className="flex gap-3 text-sm">
              <button
                onClick={() => setSelected(new Set(clean.map((w) => w.id)))}
                className="text-brand-700 hover:underline"
              >
                Select all
              </button>
              {selected.size > 0 && (
                <button onClick={() => setSelected(new Set())} className="text-gray-600 hover:underline">
                  Clear
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-gray-500 mb-2">
            These match their order on rate, phase, job and dates, and have a
            photo and something to bill. Tick and pass them without opening each one.
          </p>

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-8 px-3 py-2"></th>
                  {shown.map((c) => <th key={c.key} className="px-3 py-2 text-left font-medium whitespace-nowrap">{c.label}</th>)}
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {clean.map((w) => (
                  <tr key={w.id} className={`border-t border-gray-100 ${selected.has(w.id) ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(w.id)}
                        onChange={() => toggle(w.id)}
                        aria-label="Select for approval"
                      />
                    </td>
                    {shown.map((c) => (
                      <td key={c.key} className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {c.get(w) || '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <Link href={`/work-orders/${w.id}`} className="text-xs text-brand-700 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <button
              onClick={approveSelected}
              disabled={busy || selected.size === 0}
              className="px-4 py-2 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-40"
            >
              {busy
                ? (progress || 'Approving…')
                : selected.size === 0
                  ? 'Approve selected'
                  : `Approve ${selected.size} · $${selectedTotal.toFixed(2)}`}
            </button>
            <span className="text-xs text-gray-500">
              Approving raises each customer&apos;s QuickBooks invoice.
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
