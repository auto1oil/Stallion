'use client';
import { useCallback, useEffect, useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import { createClient } from '@/lib/supabase-browser';
import { CHARGE_TYPES, chargeTypeLabel, RECEIPT_BUCKET, type Charge } from '@/lib/charges';

// Every charge anyone has recorded, receipt attached — the office's side of
// the fuel/misc spend. Filter by kind, person, and dates; the totals follow
// the filter, so "fuel in September" is two taps.

export default function AdminChargesPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Charge[] | null>(null);
  const [error, setError] = useState('');
  const [type, setType] = useState('');
  const [who, setWho] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const refresh = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('charges').select('*')
      .order('charged_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (err) { setError(err.message); setRows([]); return; }
    setRows((data as Charge[]) || []);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function remove(c: Charge) {
    if (!window.confirm(`Delete this $${Number(c.amount).toFixed(2)} ${chargeTypeLabel(c.type)} charge from ${c.spent_by_name || 'unknown'}?`)) return;
    const { error: err } = await supabase.from('charges').delete().eq('id', c.id);
    if (err) { setError(err.message); return; }
    await supabase.storage.from(RECEIPT_BUCKET).remove([c.receipt_path]).catch(() => null);
    refresh();
  }

  async function openReceipt(c: Charge) {
    const tab = window.open('about:blank', '_blank');
    const { data } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(c.receipt_path, 300);
    if (!data?.signedUrl) { tab?.close(); setError('Could not open that receipt.'); return; }
    if (tab) tab.location.href = data.signedUrl; else window.location.href = data.signedUrl;
  }

  const norm = (s: string | null) => (s || '').toLowerCase();
  const visible = (rows || []).filter((c) =>
    (!type || c.type === type)
    && (!who || norm(c.spent_by_name).includes(who.toLowerCase()))
    && (!from || c.charged_on >= from)
    && (!to || c.charged_on <= to));
  const total = visible.reduce((n, c) => n + Number(c.amount || 0), 0);
  const fuelTotal = visible.filter((c) => c.type === 'fuel').reduce((n, c) => n + Number(c.amount || 0), 0);

  const input = 'px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white';

  return (
    <div>
      <AdminSubNav
        tabs={[{ href: '/admin/charges', label: 'Charges' }]}
        roles={['office', 'admin', 'master_admin']}
      />
      <h1 className="text-2xl font-semibold mb-1">Charges</h1>
      <p className="text-sm text-gray-500 mb-4">
        Fuel and misc purchases, each with its scanned receipt. A charge cannot
        be recorded without one.
      </p>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 mb-4 flex flex-wrap gap-3 items-end">
        <label className="text-xs text-gray-600">Kind
          <select value={type} onChange={(e) => setType(e.target.value)} className={`${input} block mt-1`}>
            <option value="">All</option>
            {CHARGE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Who
          <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name"
            className={`${input} block mt-1 w-36`} />
        </label>
        <label className="text-xs text-gray-600">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${input} block mt-1`} />
        </label>
        <label className="text-xs text-gray-600">To
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`${input} block mt-1`} />
        </label>
        <span className="text-sm text-gray-700 ml-auto">
          <strong className="tabular-nums">${total.toFixed(2)}</strong> shown
          {type === '' && visible.length > 0 && (
            <span className="text-gray-500"> · fuel ${fuelTotal.toFixed(2)} / misc ${(total - fuelTotal).toFixed(2)}</span>
          )}
        </span>
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {rows === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500">
          {rows.length === 0 ? 'No charges recorded yet.' : 'Nothing matches those filters.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Who</th>
                <th className="px-3 py-2 text-left font-medium">Kind</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Where</th>
                <th className="px-3 py-2 text-left font-medium">Unit</th>
                <th className="px-3 py-2 text-left font-medium">Job</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{c.charged_on}</td>
                  <td className="px-3 py-2">{c.spent_by_name || '—'}</td>
                  <td className="px-3 py-2">{chargeTypeLabel(c.type)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">${Number(c.amount).toFixed(2)}</td>
                  <td className="px-3 py-2">{c.vendor || '—'}</td>
                  <td className="px-3 py-2">{c.unit_number || '—'}</td>
                  <td className="px-3 py-2">{c.job_number || '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => openReceipt(c)} className="text-xs text-brand-700 hover:underline mr-3">
                      Receipt
                    </button>
                    <button onClick={() => remove(c)} className="text-xs text-red-600 hover:underline">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
