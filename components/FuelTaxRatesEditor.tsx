'use client';
import { useEffect, useState } from 'react';

// Admin editor for the per-gallon fuel tax rates that the app uses as the
// source of truth (these never change, but QuickBooks sometimes zeroes them).
// One input per tax item, grouped by fuel product. "Pull from QuickBooks"
// seeds the current QB rates; Save writes them to the app.

type Resp = {
  ok: boolean;
  rates: Record<string, number>;
  products: Record<string, string[]>;
  stored: boolean;
  error?: string;
};

export default function FuelTaxRatesEditor({ onSaved }: { onSaved?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Record<string, string[]>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function applyRates(r: Record<string, number>) {
    const s: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) s[k] = String(v);
    setRates(s);
  }

  async function load() {
    setLoading(true); setErr('');
    try {
      const res = await fetch('/api/admin/fuel-tax-rates');
      const json: Resp = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Could not load tax rates'); return; }
      setProducts(json.products);
      setStored(json.stored);
      applyRates(json.rates);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load tax rates');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function syncFromQB() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const res = await fetch('/api/admin/fuel-tax-rates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      });
      const json: Resp = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'QuickBooks sync failed'); return; }
      applyRates(json.rates);
      setStored(true);
      setMsg('Pulled current rates from QuickBooks and saved.');
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'QuickBooks sync failed');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    const payload: Record<string, number> = {};
    for (const [k, v] of Object.entries(rates)) payload[k] = Number(v) || 0;
    try {
      const res = await fetch('/api/admin/fuel-tax-rates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: payload }),
      });
      const json: Resp = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Could not save'); return; }
      setStored(true);
      setMsg('Tax rates saved.');
      setTimeout(() => setMsg(''), 2500);
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const productNames = Object.keys(products);

  function productTotal(names: string[]) {
    return names.reduce((s, n) => s + (Number(rates[n]) || 0), 0);
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
      <h2 className="font-semibold mb-1">Fuel taxes (per gallon)</h2>
      <p className="text-xs text-gray-500 mb-3">
        The app uses these per-gallon tax amounts everywhere (the cost history and the taxes added
        to fuel invoices). They don’t change, so they’re stored here as the source of truth — even
        if QuickBooks zeroes a rate. Use <span className="font-medium">Pull from QuickBooks</span> to
        seed them, then adjust by hand if needed.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <>
          {!stored && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-3">
              No app-side rates saved yet — the history is using live QuickBooks rates. Pull from
              QuickBooks (or enter them) and Save to lock them in.
            </p>
          )}
          <div className="space-y-4">
            {productNames.map((p) => (
              <div key={p}>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-medium text-gray-700">{p}</h3>
                  <span className="text-xs text-gray-500 tabular-nums">
                    total ${productTotal(products[p]).toFixed(4)}/gal
                  </span>
                </div>
                <div className="mt-1 space-y-1">
                  {products[p].map((name) => (
                    <div key={name} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 text-gray-600">{name}</span>
                      <span className="text-gray-400">$</span>
                      <input
                        type="number" inputMode="decimal" step="0.0001" min={0}
                        value={rates[name] ?? ''}
                        onChange={(e) => setRates((r) => ({ ...r, [name]: e.target.value }))}
                        className="w-28 px-2 py-1 border border-gray-300 rounded text-sm tabular-nums text-right"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-4 flex-wrap">
            <button onClick={syncFromQB} disabled={busy}
              className="px-3 py-1.5 text-sm rounded-md border border-brand-500 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
              Pull from QuickBooks
            </button>
            <button onClick={save} disabled={busy}
              className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
              {busy ? 'Saving…' : 'Save tax rates'}
            </button>
            {err && <span className="text-sm text-red-600">{err}</span>}
            {msg && <span className="text-sm text-emerald-700">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
