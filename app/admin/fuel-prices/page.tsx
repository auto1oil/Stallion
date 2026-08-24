'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import {
  parseRackPriceEmail, rackLocations, rackProducts, type RackPrice,
} from '@/lib/fuel-prices';
import FuelPricesWidget from '@/components/FuelPricesWidget';

// Our fuel products that can be auto-priced. These must match the product
// names used on fuel order lines (see FUEL_PRODUCT_NAMES at invoice time).
const FUEL_PRODUCTS = ['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane'] as const;

type StoredRack = {
  location: string;
  product: string;
  eff_date: string | null;
  price: number;
  change: number | null;
  received_at: string;
};
type Mapping = { app_product: string; rack_location: string; rack_product: string };
// One editable default-tier row. Kept as strings while editing; parsed on save.
// `display` flags the single tier whose markup feeds the Today's Fuel Prices box.
type TierRow = { min: string; max: string; markup: string; display: boolean };

export default function FuelPricingPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stored, setStored] = useState<StoredRack[]>([]);
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [tiersSaving, setTiersSaving] = useState(false);
  const [tiersMsg, setTiersMsg] = useState('');
  const [tiersErr, setTiersErr] = useState('');

  // Paste-and-load state
  const [paste, setPaste] = useState('');
  const [parsed, setParsed] = useState<RackPrice[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [polling, setPolling] = useState(false);

  async function load() {
    setLoading(true);
    const [rackRes, mapRes, tierRes] = await Promise.all([
      supabase
        .from('rack_prices')
        .select('location, product, eff_date, price, change, received_at')
        .order('received_at', { ascending: false })
        .limit(500),
      supabase.from('fuel_price_mappings').select('app_product, rack_location, rack_product'),
      supabase.from('fuel_pricing_tiers').select('min_gallons, max_gallons, markup, sort_order, display_in_widget'),
    ]);
    setStored((rackRes.data as StoredRack[]) || []);
    const m: Record<string, Mapping> = {};
    for (const r of (mapRes.data as Mapping[]) || []) m[r.app_product] = r;
    setMappings(m);
    const tierRows = ((tierRes.data as { min_gallons: number; max_gallons: number | null; markup: number; sort_order: number; display_in_widget: boolean }[]) || [])
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.min_gallons - b.min_gallons))
      .map((t) => ({
        min: String(t.min_gallons),
        max: t.max_gallons == null ? '' : String(t.max_gallons),
        markup: String(t.markup),
        display: !!t.display_in_widget,
      }));
    setTiers(tierRows);
    setLoading(false);
  }

  function updateTier(i: number, field: keyof TierRow, value: string) {
    setTiers((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function addTier() {
    setTiers((rows) => [...rows, { min: '', max: '', markup: '', display: false }]);
  }
  function removeTier(i: number) {
    setTiers((rows) => rows.filter((_, idx) => idx !== i));
  }
  // Exactly one tier feeds the Today's Fuel Prices box — checking one clears
  // the rest (radio-like); unchecking leaves none flagged.
  function toggleDisplay(i: number, checked: boolean) {
    setTiers((rows) => rows.map((r, idx) => ({ ...r, display: checked && idx === i })));
  }

  async function saveTiers() {
    setTiersErr(''); setTiersMsg('');
    // Parse + validate. Blank "max" means no upper bound.
    const parsedRows: { min_gallons: number; max_gallons: number | null; markup: number; sort_order: number; display_in_widget: boolean }[] = [];
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      const min = Number(t.min);
      const max = t.max.trim() === '' ? null : Number(t.max);
      const markup = Number(t.markup);
      if (!Number.isFinite(min) || min < 0) { setTiersErr(`Row ${i + 1}: "From" must be a number.`); return; }
      if (max !== null && (!Number.isFinite(max) || max < min)) { setTiersErr(`Row ${i + 1}: "To" must be blank or ≥ "From".`); return; }
      if (!Number.isFinite(markup)) { setTiersErr(`Row ${i + 1}: "$ over rack" must be a number.`); return; }
      parsedRows.push({ min_gallons: min, max_gallons: max, markup, sort_order: i + 1, display_in_widget: t.display });
    }
    if (parsedRows.length === 0) { setTiersErr('Add at least one tier.'); return; }
    setTiersSaving(true);
    // Full replace: clear the table, then insert the current set.
    const { error: delErr } = await supabase.from('fuel_pricing_tiers').delete().not('id', 'is', null);
    if (delErr) { setTiersSaving(false); setTiersErr('Could not save tiers: ' + delErr.message); return; }
    const { error: insErr } = await supabase.from('fuel_pricing_tiers').insert(parsedRows);
    setTiersSaving(false);
    if (insErr) { setTiersErr('Could not save tiers: ' + insErr.message); return; }
    setTiersMsg('Default pricing saved.');
    setTimeout(() => setTiersMsg(''), 2500);
    load();
  }
  useEffect(() => { load(); }, []);

  // Latest stored row per (location, product) — what we actually price off.
  const latest = useMemo(() => {
    const seen = new Map<string, StoredRack>();
    for (const r of stored) {
      const k = `${r.location}|||${r.product}`;
      if (!seen.has(k)) seen.set(k, r); // stored is received_at desc, first = newest
    }
    return Array.from(seen.values()).sort(
      (a, b) => a.location.localeCompare(b.location) || a.product.localeCompare(b.product),
    );
  }, [stored]);

  // Distinct locations/products for the mapping dropdowns — prefer freshly
  // parsed rows, fall back to what's already stored.
  const locOptions = useMemo(
    () => (parsed.length ? rackLocations(parsed) : Array.from(new Set(latest.map((r) => r.location))).sort()),
    [parsed, latest],
  );
  const prodOptions = useMemo(
    () => (parsed.length ? rackProducts(parsed) : Array.from(new Set(latest.map((r) => r.product))).sort()),
    [parsed, latest],
  );

  function onParse() {
    setErr(''); setMsg('');
    const rows = parseRackPriceEmail(paste);
    if (rows.length === 0) {
      setErr('Couldn’t find any price rows. Paste the full rack-price email, including the LOCATION/PRODUCT/PRICE lines.');
      setParsed([]);
      return;
    }
    setParsed(rows);
    setMsg(`Found ${rows.length} price rows. Review below, then Save.`);
  }

  async function onPollEmail() {
    setPolling(true); setErr(''); setMsg('');
    try {
      const res = await fetch('/api/fuel-prices/poll', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Email check failed'); return; }
      if (json.rowsSaved > 0) {
        setMsg(`Pulled ${json.rowsSaved} rack prices from email.`);
        load();
      } else {
        setMsg('No new rack-price email found in the mailbox.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Email check failed');
    } finally {
      setPolling(false);
    }
  }

  async function onSave() {
    if (parsed.length === 0) return;
    setSaving(true); setErr(''); setMsg('');
    const rows = parsed.map((r) => ({
      location: r.location, product: r.product, eff_date: r.effDate,
      price: r.price, change: r.change, source: 'dtn-sinclair',
      received_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('rack_prices')
      .upsert(rows, { onConflict: 'location,product,eff_date' });
    setSaving(false);
    if (error) { setErr('Could not save prices: ' + error.message); return; }
    setMsg(`Saved ${rows.length} rack prices.`);
    setPaste(''); setParsed([]);
    load();
  }

  async function setMapping(appProduct: string, field: 'rack_location' | 'rack_product', value: string) {
    const cur = mappings[appProduct] || { app_product: appProduct, rack_location: '', rack_product: '' };
    const next = { ...cur, [field]: value };
    setMappings((m) => ({ ...m, [appProduct]: next }));
    if (next.rack_location && next.rack_product) {
      await supabase.from('fuel_price_mappings').upsert(
        { app_product: appProduct, rack_location: next.rack_location, rack_product: next.rack_product, updated_at: new Date().toISOString() },
        { onConflict: 'app_product' },
      );
    }
  }

  function fmtDate(d: string | null) {
    return d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '—';
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-2xl font-semibold">Fuel Pricing</h1>
        <Link
          href="/admin/fuel-history"
          className="text-sm font-medium text-brand-700 hover:bg-brand-50 border border-brand-300 rounded-md px-3 py-1 whitespace-nowrap"
        >
          History
        </Link>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Set the default volume pricing, load tonight’s Sinclair rack prices, and map them to your
        products. Fuel orders price themselves (rack price + the tier markup for that volume).
      </p>

      {/* Quick-glance fuel prices — same box the reps see. */}
      <FuelPricesWidget />

      {/* 0. Default volume pricing tiers */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Default volume pricing</h2>
        <p className="text-xs text-gray-500 mb-3">
          Every customer uses these markups over rack, picked by the order’s gallons — unless a
          customer has <span className="font-medium">special pricing</span> turned on. This is what
          shows on the salesman dashboard. Leave the last tier’s “To” blank for “and up”. Check the
          box on the line whose price should show in the <span className="font-medium">Today’s Fuel
          Prices</span> box — change it anytime.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="px-2 py-1 font-medium">From (gal)</th>
                <th className="px-2 py-1 font-medium">To (gal)</th>
                <th className="px-2 py-1 font-medium">$ over rack</th>
                <th className="px-2 py-1 font-medium text-center">Today’s box</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-2 py-1">
                    <input
                      type="number" inputMode="numeric" min={0}
                      value={t.min}
                      onChange={(e) => updateTier(i, 'min', e.target.value)}
                      className="w-24 px-2 py-1 border border-gray-300 rounded text-sm tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number" inputMode="numeric" min={0}
                      value={t.max}
                      onChange={(e) => updateTier(i, 'max', e.target.value)}
                      placeholder="∞"
                      className="w-24 px-2 py-1 border border-gray-300 rounded text-sm tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <div className="inline-flex items-center gap-1">
                      <span className="text-gray-400">$</span>
                      <input
                        type="number" inputMode="decimal" step="0.01" min={0}
                        value={t.markup}
                        onChange={(e) => updateTier(i, 'markup', e.target.value)}
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-sm tabular-nums"
                      />
                    </div>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={t.display}
                      onChange={(e) => toggleDisplay(i, e.target.checked)}
                      title="Use this line for the Today's Fuel Prices box"
                      aria-label="Show this line in the Today's Fuel Prices box"
                      className="h-4 w-4 accent-brand-700 cursor-pointer"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      onClick={() => removeTier(i)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <button onClick={addTier}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
            + Add tier
          </button>
          <button onClick={saveTiers} disabled={tiersSaving}
            className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
            {tiersSaving ? 'Saving…' : 'Save default pricing'}
          </button>
          {tiersErr && <span className="text-sm text-red-600">{tiersErr}</span>}
          {tiersMsg && <span className="text-sm text-emerald-700">{tiersMsg}</span>}
        </div>
      </div>

      {/* 1. Paste tonight's email */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h2 className="font-semibold">Tonight’s rack prices</h2>
          <button onClick={onPollEmail} disabled={polling}
            className="px-3 py-1.5 text-sm rounded-md border border-brand-500 text-brand-700 disabled:opacity-50 whitespace-nowrap">
            {polling ? 'Checking…' : 'Check email now'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Rack-price emails are pulled in automatically each hour — or click “Check email now”.
          You can still paste the DTN/Sinclair email below and click Load to enter prices by hand.
        </p>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={6}
          placeholder="Paste the rack-price email here…"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-xs font-mono"
        />
        <div className="flex gap-2 mt-2 flex-wrap">
          <button onClick={onParse} disabled={!paste.trim()}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
            Load
          </button>
          {parsed.length > 0 && (
            <button onClick={onSave} disabled={saving}
              className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
              {saving ? 'Saving…' : `Save ${parsed.length} prices`}
            </button>
          )}
        </div>
        {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        {msg && <p className="text-sm text-emerald-700 mt-2">{msg}</p>}

        {parsed.length > 0 && (
          <div className="mt-3 max-h-60 overflow-y-auto border border-gray-100 rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr><th className="text-left px-2 py-1">Location</th><th className="text-left px-2 py-1">Product</th><th className="text-right px-2 py-1">Price</th></tr>
              </thead>
              <tbody>
                {parsed.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2 py-1">{r.location}</td>
                    <td className="px-2 py-1">{r.product}</td>
                    <td className="px-2 py-1 text-right tabular-nums">${r.price.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2. Product mapping */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Product mapping</h2>
        <p className="text-xs text-gray-500 mb-3">
          Tell the app which rack line feeds each of your fuel products.
        </p>
        <div className="space-y-2">
          {FUEL_PRODUCTS.map((ap) => {
            const map = mappings[ap];
            return (
              <div key={ap} className="flex items-center gap-2 flex-wrap text-sm">
                <span className="w-24 font-medium shrink-0">{ap}</span>
                <span className="text-gray-400 text-xs">=</span>
                <select
                  value={map?.rack_location || ''}
                  onChange={(e) => setMapping(ap, 'rack_location', e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded bg-white max-w-[180px]"
                >
                  <option value="">Location…</option>
                  {locOptions.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <select
                  value={map?.rack_product || ''}
                  onChange={(e) => setMapping(ap, 'rack_product', e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded bg-white max-w-[180px]"
                >
                  <option value="">Rack product…</option>
                  {prodOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            );
          })}
        </div>
        {locOptions.length === 0 && (
          <p className="text-[11px] text-gray-400 mt-2">Load a rack-price email first to populate the dropdowns.</p>
        )}
      </div>

      {/* 3. Current rack prices */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold mb-3">Current rack prices</h2>
        {latest.length === 0 ? (
          <p className="text-sm text-gray-500">No rack prices loaded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-2 py-1 font-medium text-gray-600">Location</th>
                <th className="text-left px-2 py-1 font-medium text-gray-600">Product</th>
                <th className="text-right px-2 py-1 font-medium text-gray-600">Price</th>
                <th className="text-right px-2 py-1 font-medium text-gray-600">Eff date</th>
              </tr>
            </thead>
            <tbody>
              {latest.map((r, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-2 py-1">{r.location}</td>
                  <td className="px-2 py-1">{r.product}</td>
                  <td className="px-2 py-1 text-right tabular-nums">${Number(r.price).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right text-gray-500">{fmtDate(r.eff_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
