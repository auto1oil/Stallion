'use client';
import { useEffect, useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import { createClient } from '@/lib/supabase-browser';

// Work-order setup: which QuickBooks item every ticket bills against, and the
// agreed rate per job/phase that the ticket form offers the crew.

type QBItem = { id: string; name: string };
type Rate = {
  id: string;
  job_number: string;
  phase_code: string | null;
  description: string | null;
  rate: number;
  rate_unit: string;
  active: boolean;
};

const RATE_UNITS = ['hour', 'ton', 'load', 'day'];

export default function WorkOrderSetupPage() {
  const supabase = createClient();
  const [items, setItems] = useState<QBItem[]>([]);
  const [itemId, setItemId] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemsError, setItemsError] = useState('');
  const [savedItem, setSavedItem] = useState(false);

  const [rates, setRates] = useState<Rate[]>([]);
  const [newRate, setNewRate] = useState({ job_number: '', phase_code: '', description: '', rate: '', rate_unit: 'hour' });
  const [rateError, setRateError] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', ['work_order_qb_item_id', 'work_order_qb_item_name']);
      const m = new Map(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
      setItemId(m.get('work_order_qb_item_id') || '');
      setItemName(m.get('work_order_qb_item_name') || '');
      await loadRates();
      // The QuickBooks catalog is only reachable through the server route.
      try {
        const res = await fetch('/api/quickbooks/items', { cache: 'no-store' });
        const json = await res.json();
        if (json.ok) setItems((json.items as QBItem[]) || []);
        else setItemsError(json.error || 'Could not read the QuickBooks catalog.');
      } catch {
        setItemsError('Could not reach QuickBooks.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRates() {
    const { data } = await supabase
      .from('job_rates')
      .select('id, job_number, phase_code, description, rate, rate_unit, active')
      .order('job_number');
    setRates((data as Rate[]) || []);
  }

  async function saveItem(id: string) {
    const picked = items.find((i) => i.id === id);
    setItemId(id);
    setItemName(picked?.name || '');
    setSavedItem(false);
    await supabase.from('app_settings').upsert([
      { key: 'work_order_qb_item_id', value: id },
      { key: 'work_order_qb_item_name', value: picked?.name || '' },
    ], { onConflict: 'key' });
    setSavedItem(true);
    setTimeout(() => setSavedItem(false), 1500);
  }

  async function addRate() {
    setRateError('');
    const job = newRate.job_number.trim();
    const amount = Number(newRate.rate);
    if (!job) { setRateError('Enter the job number.'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setRateError('Enter the rate.'); return; }
    const { error } = await supabase.from('job_rates').insert({
      job_number: job,
      phase_code: newRate.phase_code.trim() || null,
      description: newRate.description.trim() || null,
      rate: amount,
      rate_unit: newRate.rate_unit,
    });
    if (error) { setRateError(error.message); return; }
    setNewRate({ job_number: '', phase_code: '', description: '', rate: '', rate_unit: 'hour' });
    await loadRates();
  }

  async function removeRate(id: string) {
    await supabase.from('job_rates').delete().eq('id', id);
    await loadRates();
  }

  const input = 'px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';

  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/work-orders', label: 'All tickets' },
          { href: '/work-orders/approve', label: 'Approve' },
          { href: '/work-orders/setup', label: 'Setup' },
        ]}
        roles={['office', 'admin', 'master_admin']}
      />
      <h1 className="text-2xl font-semibold mb-4">Work order setup</h1>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">QuickBooks item</h2>
        <p className="text-xs text-gray-500 mb-3">
          Every approved ticket bills one line against this item — hours (or tonnage) × the ticket&apos;s rate.
        </p>
        {itemsError ? (
          <p className="text-sm text-red-600">{itemsError}</p>
        ) : (
          <select value={itemId} onChange={(e) => saveItem(e.target.value)} className={`${input} w-full max-w-md`}>
            <option value="">— Pick an item —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        {itemId && <p className="text-xs text-gray-500 mt-2">Billing as <strong>{itemName || itemId}</strong>.</p>}
        {savedItem && <p className="text-xs text-emerald-700 mt-1">Saved ✓</p>}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold mb-1">Job rates</h2>
        <p className="text-xs text-gray-500 mb-3">
          What each job pays. The ticket form offers the matching rate so the crew doesn&apos;t have to
          remember it, and contractors see this list on their Rates tab.
        </p>

        <div className="flex flex-wrap gap-2 items-end mb-3">
          <label className="text-xs text-gray-600">Job #
            <input value={newRate.job_number} onChange={(e) => setNewRate({ ...newRate, job_number: e.target.value })} className={`${input} w-28 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Phase
            <input value={newRate.phase_code} onChange={(e) => setNewRate({ ...newRate, phase_code: e.target.value })} className={`${input} w-24 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Description
            <input value={newRate.description} onChange={(e) => setNewRate({ ...newRate, description: e.target.value })} className={`${input} w-48 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Rate
            <input type="number" step="0.01" min="0" value={newRate.rate} onChange={(e) => setNewRate({ ...newRate, rate: e.target.value })} className={`${input} w-24 block mt-1 text-right`} />
          </label>
          <label className="text-xs text-gray-600">Per
            <select value={newRate.rate_unit} onChange={(e) => setNewRate({ ...newRate, rate_unit: e.target.value })} className={`${input} block mt-1`}>
              {RATE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <button onClick={addRate} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Add
          </button>
        </div>
        {rateError && <p className="text-xs text-red-600 mb-2">{rateError}</p>}

        {rates.length === 0 ? (
          <p className="text-sm text-gray-500">No rates set yet.</p>
        ) : (
          <div className="border border-gray-200 rounded-md divide-y divide-gray-100">
            {rates.map((r) => (
              <div key={r.id} className="px-3 py-2 flex justify-between items-center gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">Job {r.job_number}</span>
                  {r.phase_code ? <span className="text-gray-500"> · phase {r.phase_code}</span> : null}
                  {r.description ? <span className="block text-xs text-gray-500 truncate">{r.description}</span> : null}
                </span>
                <span className="shrink-0 tabular-nums">${Number(r.rate).toFixed(2)}/{r.rate_unit}</span>
                <button onClick={() => removeRate(r.id)} className="shrink-0 text-xs text-red-600 hover:underline">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
