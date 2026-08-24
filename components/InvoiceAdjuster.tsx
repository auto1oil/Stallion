'use client';
import { useEffect, useMemo, useState } from 'react';

// Admin invoice corrections: loads the order's QB invoice lines + the QB item
// catalog, lets the admin change product, quantity, and unit price, add new
// lines, or delete lines, then rebuilds the invoice in QuickBooks (in place)
// and refreshes the stored PDF.

type ApiLine = { id: string; qb_item_id: string; name: string; qty: number; unit_price: number; amount: number };
type QBItem = { id: string; name: string; unit_price: number | null };
// A row in the editor. `lineId` present = existing QB line; absent = new.
type Row = { key: string; lineId?: string; qbItemId: string; name: string; qty: string; unitPrice: string };

let keyCounter = 0;
const nextKey = () => `row-${keyCounter++}`;

export default function InvoiceAdjuster({
  orderId,
  invoiceNumber,
  onClose,
  onSaved,
}: {
  orderId: string;
  invoiceNumber: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<QBItem[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [chargeTax, setChargeTax] = useState(false);
  // Searchable product picker: which row's dropdown is open + its search text.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch(`/api/quickbooks/edit-invoice?order_id=${encodeURIComponent(orderId)}`);
        const j = await res.json();
        if (!res.ok || !j.ok) { setError(j.error || 'Could not load the invoice.'); return; }
        setItems((j.items as QBItem[]) || []);
        setChargeTax(!!j.charge_tax);
        setRows((j.lines as ApiLine[]).map((l) => {
          // Tax/fee lines: QuickBooks keeps the line's amount but zeroes the
          // per-unit rate, so derive the real unit price from amount ÷ qty. Without
          // this the line shows $0 and the total leaves the taxes out, so it
          // wouldn't match the invoice total.
          const derived = l.unit_price === 0 && l.amount > 0 && l.qty > 0
            ? Math.round((l.amount / l.qty) * 1e6) / 1e6
            : null;
          return {
            key: nextKey(), lineId: l.id, qbItemId: l.qb_item_id, name: l.name,
            qty: String(l.qty), unitPrice: String(derived ?? l.unit_price),
          };
        }));
      } catch {
        setError('Network error loading the invoice.');
      } finally {
        setLoading(false);
      }
    })();
  }, [orderId]);

  function setRow(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: nextKey(), qbItemId: '', name: '', qty: '1', unitPrice: '0' }]);
  }
  function pickItem(key: string, itemId: string) {
    const it = items.find((i) => i.id === itemId);
    const name = it?.name || '';
    // Lines default to the item's QuickBooks catalog price.
    setRow(key, {
      qbItemId: itemId,
      name,
      unitPrice: it && it.unit_price != null ? String(it.unit_price) : (rows.find((r) => r.key === key)?.unitPrice ?? '0'),
    });
  }

  function setQty(key: string, qtyStr: string) {
    setRow(key, { qty: qtyStr });
  }

  const newTotal = useMemo(() => rows.reduce((sum, r) => {
    const q = Number(r.qty), p = Number(r.unitPrice);
    return sum + (Number.isNaN(q) || Number.isNaN(p) ? 0 : q * p);
  }, 0), [rows]);

  async function save() {
    setSaving(true); setError(''); setMsg('');
    const lines: { id?: string; qbItemId: string; qbItemName: string; qty: number; unitPrice: number }[] = [];
    for (const r of rows) {
      if (!r.qbItemId) { setError('Every line needs a product selected.'); setSaving(false); return; }
      const q = Number(r.qty), p = Number(r.unitPrice);
      if (Number.isNaN(q) || q <= 0) { setError(`Invalid quantity on "${r.name || 'a line'}".`); setSaving(false); return; }
      if (Number.isNaN(p) || p < 0) { setError(`Invalid price on "${r.name || 'a line'}".`); setSaving(false); return; }
      lines.push({ id: r.lineId, qbItemId: r.qbItemId, qbItemName: r.name, qty: q, unitPrice: p });
    }
    if (lines.length === 0) { setError('An invoice needs at least one line.'); setSaving(false); return; }
    try {
      const res = await fetch('/api/quickbooks/edit-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, lines, charge_tax: chargeTax }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error || 'Could not update the invoice.'); return; }
      setMsg(j.partial ? (j.warning || 'Updated in QuickBooks (PDF refresh failed).') : 'Invoice updated in QuickBooks and PDF refreshed.');
      onSaved();
      if (!j.partial) setTimeout(onClose, 1200);
    } catch {
      setError('Network error saving the invoice.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <span className="font-semibold">Adjust invoice {invoiceNumber ? `#${invoiceNumber}` : ''}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4">
          {loading ? (
            <p className="text-sm text-gray-500">Loading invoice from QuickBooks…</p>
          ) : error && rows.length === 0 ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <>
              <div className="space-y-2">
                {rows.map((r) => (
                  <div key={r.key} className="flex items-center gap-2 flex-wrap border-b border-gray-100 pb-2">
                    <div className="relative flex-1 min-w-[150px] max-w-full">
                      <input
                        type="text"
                        value={openRow === r.key ? itemSearch : (r.name || '')}
                        placeholder="Search product…"
                        onFocus={() => { setOpenRow(r.key); setItemSearch(''); }}
                        onChange={(e) => { setOpenRow(r.key); setItemSearch(e.target.value); }}
                        onBlur={() => setTimeout(() => setOpenRow((cur) => (cur === r.key ? null : cur)), 150)}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-sm bg-white"
                      />
                      {openRow === r.key && (
                        <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                          {(() => {
                            const term = itemSearch.trim().toLowerCase();
                            const list = items.filter((i) => !term || i.name.toLowerCase().includes(term)).slice(0, 60);
                            if (list.length === 0) return <div className="px-2 py-2 text-xs text-gray-400">No matching products.</div>;
                            return list.map((i) => (
                              <button
                                key={i.id}
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); pickItem(r.key, i.id); setOpenRow(null); setItemSearch(''); }}
                                className={`block w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 ${i.id === r.qbItemId ? 'bg-brand-50 text-brand-700' : ''}`}
                              >
                                {i.name}{i.unit_price != null ? <span className="text-gray-400"> — ${i.unit_price.toFixed(2)}</span> : null}
                              </button>
                            ));
                          })()}
                        </div>
                      )}
                    </div>
                    <label className="text-xs text-gray-500">Qty
                      <input type="number" step="any" value={r.qty} onChange={(e) => setQty(r.key, e.target.value)}
                        className="w-16 ml-1 px-2 py-1 border border-gray-300 rounded text-sm text-right" />
                    </label>
                    <label className="text-xs text-gray-500">$
                      <input type="number" step="0.0001" value={r.unitPrice} onChange={(e) => setRow(r.key, { unitPrice: e.target.value })}
                        className="w-24 ml-1 px-2 py-1 border border-gray-300 rounded text-sm text-right" />
                    </label>
                    <button onClick={() => removeRow(r.key)} className="text-xs text-red-600 hover:underline" title="Delete this line">Delete</button>
                  </div>
                ))}
              </div>
              <button onClick={addRow} className="mt-2 text-sm text-brand-700 hover:underline font-medium">+ Add product</button>
              <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer">
                <input type="checkbox" checked={chargeTax} onChange={(e) => setChargeTax(e.target.checked)} className="w-4 h-4" />
                <span className="font-medium">Charge sales tax</span>
                <span className="text-xs text-gray-500">— QuickBooks adds tax on taxable lines.</span>
              </label>
              <div className="flex justify-between items-center mt-2 text-sm">
                <span className="text-gray-500">New total (before sales tax)</span>
                <span className="font-semibold tabular-nums">${newTotal.toFixed(2)}</span>
              </div>
              {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
              {msg && <p className="text-xs text-emerald-700 mt-2">{msg}</p>}
              <div className="flex gap-2 mt-4">
                <button onClick={save} disabled={saving}
                  className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
                  {saving ? 'Updating QuickBooks…' : 'Save & update QuickBooks'}
                </button>
                <button onClick={onClose} className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              </div>
              <p className="text-[11px] text-gray-400 mt-2">
                Change products, quantities, or prices; add or delete lines. Edits the existing
                QuickBooks invoice in place and re-downloads the corrected PDF.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
