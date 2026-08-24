'use client';
import { useState } from 'react';
import { type CartItem } from '@/lib/cart';

// Inline custom-item rows — for ordering anything not in the catalog yet.
// Lives at the bottom of the product list on /shop and the
// admin order detail.
//
// Starts with a single row; a "+ Add another item" button adds more. Each row
// is independent: type a description, pick a quantity, hit Add (or press
// Enter). The product line gets saved with product_id = null and
// is_custom = true so the admin can spot catalog gaps on the order detail.

type RowState = { text: string; qty: string };
const emptyRow: RowState = { text: '', qty: '1' };

export default function CustomItemButton({
  onAdd,
  className = '',
}: {
  onAdd: (item: CartItem) => void;
  className?: string;
}) {
  const [rows, setRows] = useState<RowState[]>(() => [{ ...emptyRow }]);

  function updateRow(i: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function addRow(i: number) {
    const r = rows[i];
    const q = parseInt(r.qty, 10);
    if (!r.text.trim() || !q || q < 1) return;
    onAdd({
      product_id: null,
      product_name: r.text.trim(),
      container_size: '—',
      brand: null,
      weight: null,
      quantity: q,
      is_custom: true,
    });
    // Clear that row so the user can keep typing.
    updateRow(i, { ...emptyRow });
  }

  return (
    <div className={`bg-white border border-dashed border-brand-300 rounded-lg p-3 ${className}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Custom items
        <span className="ml-2 font-normal text-gray-400 lowercase">— anything not listed</span>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2 items-center flex-wrap">
            <input
              type="text"
              value={r.text}
              onChange={(e) => updateRow(i, { text: e.target.value })}
              placeholder="Type what you'd like to order…"
              className="flex-1 min-w-[180px] px-3 py-2 border border-gray-300 rounded-md text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRow(i);
                }
              }}
            />
            <input
              type="number"
              min={1}
              value={r.qty}
              onChange={(e) => updateRow(i, { qty: e.target.value })}
              aria-label={`Quantity for custom item ${i + 1}`}
              className="w-20 px-3 py-2 border border-gray-300 rounded-md text-sm tabular-nums"
            />
            <button
              onClick={() => addRow(i)}
              disabled={!r.text.trim()}
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              Add
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setRows((prev) => [...prev, { ...emptyRow }])}
        className="mt-2 text-sm text-brand-700 hover:underline font-medium"
      >
        + Add another item
      </button>
    </div>
  );
}
