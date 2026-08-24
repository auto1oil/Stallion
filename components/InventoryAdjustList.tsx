'use client';

// Inventory count adjuster for drivers + admins. Shows each item's current
// on-hand with an empty "New count" box. Fill in the correct counts down the
// list, hit Save once, and it updates the app's inventory levels and pushes the
// new counts to QuickBooks. Read list comes from /api/staff/inventory; the save
// goes through /api/inventory/adjust (service-role).

import { useEffect, useState } from 'react';

type Item = { id: string; name: string; packaging: string | null; qty_on_hand: number | null; retail_price: number | null };

export default function InventoryAdjustList() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({}); // item_id -> typed new count
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/staff/inventory');
      const j = await res.json();
      if (j.ok) setItems(j.items as Item[]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? items.filter((i) => `${i.name} ${i.packaging || ''}`.toLowerCase().includes(needle))
    : items;

  const pending = Object.entries(counts).filter(([, v]) => v.trim() !== '').length;

  async function save() {
    const adjustments = Object.entries(counts)
      .filter(([, v]) => v.trim() !== '')
      .map(([item_id, v]) => ({ item_id, new_qty: Number(v) }))
      .filter((a) => Number.isFinite(a.new_qty) && a.new_qty >= 0);
    if (adjustments.length === 0) { setErr('Enter a count on at least one item.'); return; }
    setSaving(true); setErr(''); setMsg('');
    try {
      const res = await fetch('/api/inventory/adjust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustments }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not save.'); return; }
      const qbErrs = (j.qb?.errors?.length ?? 0) + (j.qb_error ? 1 : 0);
      const parts = [`Updated ${j.app_updated} item${j.app_updated === 1 ? '' : 's'}.`];
      if (j.qb) parts.push(`QuickBooks: ${j.qb.updated} synced${qbErrs ? `, ${qbErrs} couldn’t (do those in QuickBooks)` : ''}.`);
      else if (j.qb_error) parts.push(`QuickBooks push failed: ${j.qb_error}`);
      setMsg(parts.join(' '));
      setCounts({});
      load();
    } catch {
      setErr('Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search inventory…"
        className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-md text-base"
      />

      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}
      {msg && <div className="mb-3 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{msg}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">{items.length === 0 ? 'No inventory items.' : 'No matches.'}</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {visible.map((it) => (
            <div key={it.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{it.name}</div>
                {it.packaging && <div className="text-xs text-gray-500">{it.packaging}</div>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right w-14">
                  <div className={`text-base font-semibold tabular-nums ${(it.qty_on_hand ?? 0) <= 0 ? 'text-red-600' : 'text-gray-800'}`}>
                    {it.qty_on_hand ?? '—'}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">on hand</div>
                </div>
                <label className="text-[10px] uppercase tracking-wide text-gray-400 flex flex-col items-center">
                  New count
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={counts[it.id] ?? ''}
                    onChange={(e) => setCounts((c) => ({ ...c, [it.id]: e.target.value }))}
                    placeholder="—"
                    className="mt-0.5 w-20 px-2 py-1.5 border border-gray-300 rounded text-sm text-right"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sticky save bar — only matters once a count is entered. */}
      <div className="sticky bottom-0 mt-3 bg-gray-50/95 backdrop-blur py-3">
        <button
          onClick={save}
          disabled={saving || pending === 0}
          className="w-full py-2.5 rounded-md bg-brand-700 text-white font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : pending > 0 ? `Save ${pending} change${pending === 1 ? '' : 's'}` : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
