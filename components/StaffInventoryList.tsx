'use client';

// Read-only stock list for salesmen + drivers: description, quantity on hand,
// and retail price only (never cost). Data from /api/staff/inventory.

import { useEffect, useState } from 'react';

type Item = { id: string; name: string; packaging: string | null; qty_on_hand: number | null; retail_price: number | null };

export default function StaffInventoryList() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/staff/inventory');
        const json = await res.json();
        if (json.ok) setItems(json.items as Item[]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? items.filter((i) => `${i.name} ${i.packaging || ''}`.toLowerCase().includes(needle))
    : items;

  return (
    <div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search inventory…"
        className="w-full mb-4 px-3 py-2 border border-gray-300 rounded-md text-base"
      />

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
              <div className="flex items-center gap-4 shrink-0 text-right">
                <div>
                  <div className="text-sm font-semibold tabular-nums text-gray-800">{money(it.retail_price)}</div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">retail</div>
                </div>
                <div className="w-12">
                  <div className={`text-base font-semibold tabular-nums ${(it.qty_on_hand ?? 0) <= 0 ? 'text-red-600' : 'text-gray-800'}`}>
                    {it.qty_on_hand ?? '—'}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">on hand</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
