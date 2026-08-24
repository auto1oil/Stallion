'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import InventoryAdjustList from '@/components/InventoryAdjustList';

// Admin-only product cost history: what we paid for each item, by date and
// vendor, pulled live from QuickBooks Bills + Purchases since Jan 1, 2026.
type CostRow = { date: string | null; product: string; cost: number; qty: number | null; vendor: string };

function stripPkg(name: string): string {
  const i = (name || '').indexOf(':');
  return i >= 0 ? name.slice(i + 1).trim() : name;
}
function fmtDate(d: string | null): string {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function CostHistory() {
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const res = await fetch('/api/admin/cost-history');
      const data = await res.json();
      if (!data.ok) { setErr(data.error || 'Failed to load'); setRows([]); }
      else setRows(data.rows as CostRow[]);
    } catch {
      setErr('Failed to load');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = rows || [];
    if (!needle) return all;
    return all.filter((r) => `${r.product} ${r.vendor}`.toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by product or vendor…"
          className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        {rows && <span className="text-xs text-gray-400">{filtered.length} of {rows.length}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        What each product cost, by date and vendor — pulled live from QuickBooks bills &amp; expenses since Jan 1, 2026.
      </p>

      {err && <p className="text-sm text-red-600">{err} <button onClick={load} className="underline">Retry</button></p>}
      {!err && (loading || rows === null) && <p className="text-sm text-gray-500">Loading cost history…</p>}
      {!err && rows && filtered.length === 0 && <p className="text-sm text-gray-400">No item costs found.</p>}

      {!err && filtered.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Cost</th>
                <th className="text-left px-3 py-2">Product</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Vendor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-semibold tabular-nums whitespace-nowrap">${r.cost.toFixed(2)}{r.qty ? <span className="text-gray-400 font-normal"> ×{r.qty}</span> : null}</td>
                  <td className="px-3 py-1.5">{stripPkg(r.product)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-gray-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-gray-700">{r.vendor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Vendor price comparison ──────────────────────────────────────────────────
// Groups the QuickBooks bill/expense cost rows into the product types we shop
// around for, and shows each vendor's most-recent unit cost side by side so the
// admin can glance at who's cheapest. Each vendor names products differently, so
// we match by viscosity + type (full-synthetic vs blend) + pack (bulk vs case),
// and expose the matched line items so the grouping can be verified/trusted.
type CmpCostRow = { date: string | null; product: string; cost: number; qty: number | null; vendor: string };

const upc = (s: string) => (s || '').toUpperCase();
const tight = (s: string) => upc(s).replace(/[^A-Z0-9]/g, '');       // "5W-30" → "5W30"
const hasVisc = (n: string, v: string) => tight(n).includes(v);
const isBlendOil = (n: string) => /BLEND/.test(upc(n));
const isSyntheticOil = (n: string) => /SYNTHETIC|FULLSYN/.test(upc(n)) && !isBlendOil(n);
const CASE_RE = /(CASE|\bCS\b|\bEBOX\b|\bBOX\b|\bPK\b|\bQT\b|QUART|\d+\s*\/\s*\d+)/;
const isCasebook = (n: string) => CASE_RE.test(upc(n));

// Gallons contained in ONE billed unit, so per-container prices (a tote, a drum,
// a 4/1 case, a 5-gal pail…) can be normalized to price-per-gallon and actually
// compared. Returns null when we can't tell (e.g. weight-based grease kegs) —
// those are shown as-is and excluded from the "cheapest" pick.
function gallonsPerUnit(name: string): number | null {
  const n = upc(name);
  if (/\bLB\b|KEG|GREASE|\bGREASE\b/.test(n)) return null;          // weight-based
  if (/TOTE|\bIBC\b/.test(n)) return 330;                           // IBC tote (~330 gal)
  if (/205\s*L/.test(n)) return 54.2;                               // 205-litre drum
  if (/\bDRUM\b|\b55\s*GAL|\b55GL\b/.test(n)) return 55;            // 55-gal drum
  const m = n.match(/(\d+)\s*\/\s*(\d+)/);                          // pack ratio: 4/1, 1/5, 12/1QT…
  if (m) {
    const packs = Number(m[1]);      // number of containers
    const each = Number(m[2]);       // size of each container
    if (packs > 0 && each > 0) return /QT|QUART/.test(n) ? (packs * each) / 4 : packs * each;
  }
  if (/\bGAL\b|GALLON|\bGL\b/.test(n)) return 1;                    // single gallon
  return null;
}
// Short pack label for display (the QB "PACKAGING:" prefix).
function packOf(name: string): string {
  const i = (name || '').indexOf(':');
  return i > 0 ? name.slice(0, i).trim() : '';
}

type Cmp = { key: string; label: string; pack: string; test: (n: string) => boolean };
const CMP_CATS: Cmp[] = [
  { key: 'fs530',   label: 'Full Synthetic 5W-30', pack: '',           test: (n) => hasVisc(n, '5W30') && isSyntheticOil(n) },
  { key: 'sb530',   label: 'Syn-Blend 5W-30',      pack: '',           test: (n) => hasVisc(n, '5W30') && isBlendOil(n) },
  { key: 'sb1540b', label: 'Syn-Blend 15W-40',     pack: 'Bulk (gal)', test: (n) => hasVisc(n, '15W40') && isBlendOil(n) && !isCasebook(n) },
  { key: 'sb1540c', label: 'Syn-Blend 15W-40',     pack: 'Case',       test: (n) => hasVisc(n, '15W40') && isBlendOil(n) && isCasebook(n) },
  { key: 'fs540',   label: 'Full Synthetic 5W-40', pack: '',           test: (n) => hasVisc(n, '5W40') && isSyntheticOil(n) },
  { key: 'gear7590',label: '75W-90 Gear Oil',      pack: '',           test: (n) => hasVisc(n, '75W90') },
];

function VendorPriceComparison() {
  const [rows, setRows] = useState<CmpCostRow[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr('');
    try {
      const res = await fetch('/api/admin/cost-history');
      const data = await res.json();
      if (!data.ok) { setErr(data.error || 'Failed to load'); setRows([]); }
      else setRows(data.rows as CmpCostRow[]);
    } catch { setErr('Failed to load'); setRows([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  type Cell = { perGal: number | null; rawUnit: number; pack: string; date: string | null };
  const { byCat, vendors } = useMemo(() => {
    const all = rows || []; // already newest-first from the API
    const byCat: Record<string, { latest: Map<string, Cell>; matches: CmpCostRow[] }> = {};
    const vendorSet = new Set<string>();
    for (const cat of CMP_CATS) {
      const matches = all.filter((r) => cat.test(r.product));
      const latest = new Map<string, Cell>();
      for (const r of matches) {
        if (!r.vendor || r.vendor === '—') continue;
        if (!latest.has(r.vendor)) {           // first row per vendor = newest
          const gpu = gallonsPerUnit(r.product);
          latest.set(r.vendor, {
            perGal: gpu && gpu > 0 ? Math.round((r.cost / gpu) * 100) / 100 : null,
            rawUnit: r.cost,
            pack: packOf(r.product),
            date: r.date,
          });
        }
        vendorSet.add(r.vendor);
      }
      byCat[cat.key] = { latest, matches };
    }
    return { byCat, vendors: Array.from(vendorSet).sort((a, b) => a.localeCompare(b)) };
  }, [rows]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <button onClick={load} disabled={loading}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <span className="text-xs text-gray-500">Cheapest vendor per product is highlighted green.</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Each vendor&apos;s most-recent cost <span className="font-medium">per gallon</span> from your QuickBooks
        bills (since Jan 1, 2026) — totes, drums and cases are converted to $/gal so they compare fairly.
        Updates automatically as new bills come in. Tap a product to see the exact bill lines (and their pack) behind the numbers.
      </p>

      {err && <p className="text-sm text-red-600">{err} <button onClick={load} className="underline">Retry</button></p>}
      {!err && (loading || rows === null) && <p className="text-sm text-gray-500">Loading…</p>}

      {!err && rows && vendors.length === 0 && (
        <p className="text-sm text-gray-400">No matching oil purchases found in your bills yet.</p>
      )}

      {!err && rows && vendors.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 sticky left-0 bg-gray-50">Product</th>
                {vendors.map((v) => <th key={v} className="text-right px-3 py-2 whitespace-nowrap">{v}</th>)}
                <th className="text-right px-3 py-2 whitespace-nowrap">Best</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {CMP_CATS.map((cat) => {
                const cell = byCat[cat.key];
                const entries = vendors.map((v) => ({ v, p: cell.latest.get(v) }));
                // "Cheapest" only compares vendors we could normalize to $/gal.
                const perGalVals = entries.map((e) => e.p?.perGal).filter((x): x is number => x != null);
                const min = perGalVals.length ? Math.min(...perGalVals) : null;
                const bestVendor = min != null ? entries.find((e) => e.p?.perGal === min)?.v : null;
                const open = openKey === cat.key;
                return (
                  <Fragment key={cat.key}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-3 py-2 sticky left-0 bg-white">
                        <button onClick={() => setOpenKey(open ? null : cat.key)} className="text-left">
                          <div className="font-medium">{cat.label}</div>
                          {cat.pack && <div className="text-[11px] text-gray-500">{cat.pack}</div>}
                          <div className="text-[11px] text-brand-700">{open ? '▾ hide bill lines' : `▸ ${cell.matches.length} bill line${cell.matches.length === 1 ? '' : 's'}`}</div>
                        </button>
                      </td>
                      {entries.map(({ v, p }) => (
                        <td key={v} className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${p?.perGal != null && p.perGal === min ? 'bg-green-50 text-green-800 font-semibold' : ''}`}>
                          {p ? (
                            p.perGal != null ? (
                              <>
                                ${p.perGal.toFixed(2)}<span className="text-[10px] text-gray-400 font-normal">/gal</span>
                                <div className="text-[10px] text-gray-400 font-normal">{p.pack ? `${p.pack} · ` : ''}{p.date && fmtDate(p.date)}</div>
                              </>
                            ) : (
                              // Couldn't convert to $/gal (e.g. weight-based) — show raw, flagged.
                              <span title="Priced per container — can't convert to $/gal">
                                ${p.rawUnit.toFixed(2)}<span className="text-[10px] text-amber-600 font-normal">/{p.pack || 'unit'}</span>
                                <div className="text-[10px] text-gray-400 font-normal">{p.date && fmtDate(p.date)}</div>
                              </span>
                            )
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {bestVendor && min != null ? <span className="text-xs font-medium text-green-800">{bestVendor}<br /><span className="tabular-nums">${min.toFixed(2)}/gal</span></span> : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={vendors.length + 2} className="px-3 py-2 bg-gray-50">
                          {cell.matches.length === 0 ? (
                            <span className="text-xs text-gray-400">No bill lines matched this product.</span>
                          ) : (
                            <div className="text-xs text-gray-600 space-y-0.5">
                              {cell.matches.slice(0, 40).map((m, i) => {
                                const gpu = gallonsPerUnit(m.product);
                                const perGal = gpu && gpu > 0 ? m.cost / gpu : null;
                                return (
                                  <div key={i} className="flex justify-between gap-3">
                                    <span className="truncate">{stripPkg(m.product)} · <span className="text-gray-400">{m.vendor}</span></span>
                                    <span className="tabular-nums whitespace-nowrap">
                                      {perGal != null ? `$${perGal.toFixed(2)}/gal` : `$${m.cost.toFixed(2)}/${packOf(m.product) || 'unit'}`}
                                      <span className="text-gray-400"> (${m.cost.toFixed(2)}{m.qty ? ` ×${m.qty}` : ''}) · {fmtDate(m.date)}</span>
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Item = {
  id: string;
  qb_name: string;
  description: string | null;
  sku: string | null;
  packaging: string | null;
  cost: number | null;
  retail_price: number | null;
  taxable: boolean;
  qb_type: string | null;
  active: boolean;
  match_product_id: string | null;
  match_weight: string | null;
  match_container_size: string | null;
  qty_on_hand: number | null;
  qb_qty_synced_at: string | null;
  reorder_point: number | null;
  reorder_notify: boolean;
  admin_only: boolean;
};

function isLow(it: Item): boolean {
  return it.reorder_point != null && it.qty_on_hand != null && it.qty_on_hand <= it.reorder_point;
}

// QuickBooks names items as "Packaging:Product" (e.g. "GAL:SUPREME UHP DEXOS
// 0W-20", "EBOX:MAG 1 FULL SYNTHETIC DEXOS 0W-20"). The top-level parent before
// the first colon IS the packaging/section, so fall back to it when the item's
// own packaging field is blank — keeps items out of the catch-all "Other".
function packagingOf(it: Item): string {
  if (it.packaging && it.packaging.trim()) return it.packaging.trim();
  const i = (it.qb_name || '').indexOf(':');
  if (i > 0) {
    const p = it.qb_name.slice(0, i).trim();
    if (p) return p;
  }
  return 'Other';
}

// Display name without the QuickBooks "PACKAGING:" prefix (already shown as the
// section header), e.g. "GAL:SUPREME UHP DEXOS 0W-20" -> "SUPREME UHP DEXOS 0W-20".
function displayName(it: Item): string {
  const raw = (it.description || it.qb_name || '').trim();
  const i = raw.indexOf(':');
  return i >= 0 ? raw.slice(i + 1).trim() : raw;
}

// Order the packaging sections by container size: bulk at the top, working down
// to quarts / case packs (6/1) at the bottom. Ranks by the packaging label;
// unknown labels sort just above the catch-all "Other", which is always last.
// (Lower rank = higher up.) Tweak the list to reorder a section.
function packagingSizeRank(pkg: string): number {
  const p = (pkg || '').toLowerCase().trim();
  if (!p || p === 'other') return 999;
  // Rules are checked in order (first match wins). Quarts and case packs (N/M:
  // 3/1, 4/1, 6/1, 3/5, 30/14, 12/1…) are matched BEFORE the bare-number
  // container rules so e.g. "30/14" is a case pack, not a 30-gal keg.
  const rules: [RegExp, number][] = [
    [/bulk/, 1],
    [/qt|quart/, 12],                          // quarts (incl 6/1QT) → very bottom
    [/\d+\s*\/\s*\d+/, 11],                     // case packs (3/1, 4/1, 6/1, 3/5, 30/14, 12/1)
    [/tote|275|330/, 3],
    [/drum|(^|[^\d])55([^\d]|$)/, 4],
    [/120|lbs/, 5],                             // grease bulk
    [/keg|(^|[^\d])(35|30|16)([^\d]|$)/, 6],
    [/pail|5gl|(^|[^\d])5([^\d]|$)/, 7],        // 5-gal pail
    [/2\.5/, 8],
    [/ebox/, 9],
    [/(^|[^\d])gal([^\d]|$)|gallon/, 2],        // bulk gallons
  ];
  for (const [re, rank] of rules) if (re.test(p)) return rank;
  return 50; // labeled but unrecognized → middle, above "Other"
}

// Orderable catalog products (Fuel excluded) used to mirror the ordering
// dropdowns when matching an inventory item.
type CatProduct = {
  id: string;
  name: string;
  category: string;
  weights: string[] | null;
  container_sizes: string[] | null;
  sizes_by_weight: Record<string, string[]> | null;
  sort_order?: number | null;
};

// Per-item picker that mirrors the order dropdowns: Product -> Weight ->
// Container size. Records the chosen variant on the inventory item.
function VariantMatch({
  products,
  item,
  onSave,
}: {
  products: CatProduct[];
  item: Item;
  onSave: (productId: string | null, weight: string | null, size: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pid, setPid] = useState(item.match_product_id || '');
  const [weight, setWeight] = useState(item.match_weight || '');
  const [size, setSize] = useState(item.match_container_size || '');

  const prod = products.find((p) => p.id === pid) || null;
  const weights = prod?.weights || [];
  const sizes = (() => {
    if (!prod) return [] as string[];
    if (weight && prod.sizes_by_weight?.[weight]?.length) return prod.sizes_by_weight[weight];
    return prod.container_sizes || [];
  })();

  const cur = products.find((p) => p.id === item.match_product_id) || null;
  const curLabel = cur
    ? [cur.name, item.match_weight, item.match_container_size].filter(Boolean).join(' · ')
    : null;

  function save() { onSave(pid || null, weight || null, size || null); setOpen(false); }
  function clear() { setPid(''); setWeight(''); setSize(''); onSave(null, null, null); setOpen(false); }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`text-xs hover:underline ${curLabel ? 'text-brand-700' : 'text-gray-400'}`}
      >
        {curLabel ? `Matched: ${curLabel}` : '+ Match to order product'}
      </button>
    );
  }

  const grouped = products.reduce((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {} as Record<string, CatProduct[]>);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <select
        value={pid}
        onChange={(e) => { setPid(e.target.value); setWeight(''); setSize(''); }}
        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white max-w-[12rem]"
      >
        <option value="">— Product —</option>
        {Object.entries(grouped).map(([cat, list]) => (
          <optgroup key={cat} label={cat}>
            {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
        ))}
      </select>
      {weights.length > 0 && (
        <select
          value={weight}
          onChange={(e) => { setWeight(e.target.value); setSize(''); }}
          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
        >
          <option value="">— Weight —</option>
          {weights.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      )}
      {prod && (
        <select
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
        >
          <option value="">— Size —</option>
          {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      <button onClick={save} disabled={!pid} className="text-xs text-brand-700 hover:underline disabled:opacity-40">Save</button>
      {curLabel && <button onClick={clear} className="text-xs text-red-600 hover:underline">Clear</button>}
      <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:underline">Cancel</button>
    </div>
  );
}

// Add a single inventory item to the Place Order Quick list: pick a category
// and the size (defaults to the item's packaging), and it creates the Quick-
// menu product AND links this item to it so its retail price flows through.
function AddToQuickMenu({ item, categories, existingNames, onAdded }: {
  item: Item;
  categories: string[];
  existingNames: Set<string>;
  onAdded: () => void;
}) {
  const name = (item.description || item.qb_name).trim();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [newCat, setNewCat] = useState('');         // when "New category…" is picked
  const [size, setSize] = useState(item.packaging || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (existingNames.has(name.toLowerCase())) {
    return <span className="text-xs text-emerald-700">✓ In Quick menu</span>;
  }
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-brand-700 hover:underline">
        + Add to Quick menu
      </button>
    );
  }

  const chosenCategory = category === '__new__' ? newCat.trim() : category;

  async function add() {
    const cat = chosenCategory;
    if (!cat) { setErr('Pick a category.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/admin/quick-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add_from_item', inventory_item_id: item.id, category: cat, size: size.trim() }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not add.'); return; }
      setOpen(false);
      onAdded();
    } catch {
      setErr('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-gray-500">Add to Quick menu:</span>
      <select value={category} onChange={(e) => setCategory(e.target.value)}
        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white max-w-[10rem]">
        <option value="">— Category —</option>
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        <option value="__new__">+ New category…</option>
      </select>
      {category === '__new__' && (
        <input value={newCat} onChange={(e) => setNewCat(e.target.value)} autoFocus
          placeholder="New category" className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-32" />
      )}
      <input value={size} onChange={(e) => setSize(e.target.value)}
        placeholder="Size (e.g. GAL)" className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-28" />
      <button onClick={add} disabled={busy || !chosenCategory}
        className="text-xs text-brand-700 hover:underline disabled:opacity-40">{busy ? 'Adding…' : 'Add'}</button>
      <button onClick={() => { setOpen(false); setErr(''); }} className="text-xs text-gray-400 hover:underline">Cancel</button>
      {err && <span className="text-xs text-red-600 basis-full">{err}</span>}
    </div>
  );
}

// Quick-menu editor: edit the weights + container sizes shown per product, and
// remove products from the Place Order Quick list. Products are ADDED from the
// inventory list (each item has an "Add to Quick menu" control).
function QuickMenuEditor({ onClose }: { onClose: () => void }) {
  const supabase = createClient();
  const [rows, setRows] = useState<CatProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from('products')
      .select('id, name, category, weights, container_sizes, sizes_by_weight, sort_order')
      .eq('active', true)
      .order('category').order('sort_order').order('name');
    setRows((data as CatProduct[]) || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function saveRow(p: CatProduct, weights: string[], sizes: string[]) {
    setSavingId(p.id);
    setRows((prev) => prev.map((r) => (r.id === p.id ? { ...r, weights, container_sizes: sizes } : r)));
    // Goes through the service-role route — products writes are RLS-blocked.
    await fetch('/api/admin/quick-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: p.id, weights, container_sizes: sizes }),
    });
    setSavingId(null);
  }

  // Remove a product from the Quick list (and the customer shop). Soft-delete
  // via active=false so any history / inventory match keeps its reference.
  async function removeProduct(p: CatProduct) {
    if (!confirm(`Remove "${p.name}" from the Quick menu?`)) return;
    setRows((prev) => prev.filter((r) => r.id !== p.id));
    await fetch('/api/admin/quick-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', id: p.id }),
    });
  }

  const byCat = rows.reduce((acc, p) => { (acc[p.category] ||= []).push(p); return acc; }, {} as Record<string, CatProduct[]>);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <h2 className="font-semibold">Edit Quick menu</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-5">
          <p className="text-xs text-gray-500">
            Edit the weights &amp; sizes shown for each Quick-menu product, or remove one.
            To add a product, use the “Add to Quick menu” button on an item in the inventory list.
          </p>

          {loading ? <p className="text-sm text-gray-500">Loading…</p> : Object.entries(byCat).map(([cat, list]) => (
            <div key={cat}>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{cat}</div>
              <div className="space-y-3">
                {list.map((p) => (
                  <div key={p.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">{p.name}{savingId === p.id && <span className="ml-2 text-xs text-gray-400">saving…</span>}</div>
                      <button onClick={() => removeProduct(p)} className="text-xs text-red-600 hover:underline shrink-0">Remove</button>
                    </div>
                    <ChipEditor label="Weights" values={p.weights || []} onChange={(v) => saveRow(p, v, p.container_sizes || [])} />
                    <ChipEditor label="Sizes" values={p.container_sizes || []} onChange={(v) => saveRow(p, p.weights || [], v)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChipEditor({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const [add, setAdd] = useState('');
  return (
    <div className="mb-2">
      <div className="text-[11px] text-gray-500 mb-1">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-100 rounded-full">
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} className="text-gray-400 hover:text-red-600" aria-label={`Remove ${v}`}>×</button>
          </span>
        ))}
        <input
          value={add}
          onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const t = add.trim();
              if (t && !values.includes(t)) onChange([...values, t]);
              setAdd('');
            }
          }}
          placeholder="+ add"
          className="w-20 px-2 py-0.5 text-xs border border-gray-300 rounded"
        />
      </div>
    </div>
  );
}

// Editable price field — keeps a local draft and saves on blur, so typing
// doesn't churn the whole list.
function PriceCell({
  label,
  value,
  onSave,
  money = true,
}: {
  label: string;
  value: number | null;
  onSave: (v: number | null) => void;
  money?: boolean;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => { setDraft(value == null ? '' : String(value)); }, [value]);
  return (
    <label className="flex items-center gap-1 text-xs text-gray-500">
      {label}
      <span className="relative">
        {money && <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-400">$</span>}
        <input
          type="number"
          step={money ? '0.01' : '1'}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const t = draft.trim();
            const n = t === '' ? null : Number(t);
            if (n === null || !Number.isNaN(n)) onSave(n);
          }}
          className={`w-20 ${money ? 'pl-4' : 'pl-2'} pr-1.5 py-1 border border-gray-300 rounded text-sm text-right`}
        />
      </span>
    </label>
  );
}

export default function InventorySetupPage() {
  const supabase = createClient();
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<CatProduct[]>([]);
  const [isAdmin, setIsAdmin] = useState(false); // cost is admin-only
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [tab, setTab] = useState<'stock' | 'all' | 'adjust' | 'costs' | 'compare'>('stock');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [editMenu, setEditMenu] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // One-shot repair: refill cost on items that lost it (0/null) from the most
  // recent QuickBooks bill/purchase for that item. Fuel is skipped (rack-priced).
  async function restoreCosts() {
    if (!confirm('Refill missing item costs from your QuickBooks bills? This only fills items that currently have no cost — it never changes a cost that\'s already set.')) return;
    setRestoring(true); setSyncMsg(null);
    try {
      const res = await fetch('/api/admin/restore-item-costs', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) { setSyncMsg(j.error || 'Restore failed.'); return; }
      setSyncMsg(
        `Restored cost on ${j.updated_count} item${j.updated_count === 1 ? '' : 's'} from QuickBooks bills.` +
        (j.unmatched?.length ? ` ${j.unmatched.length} had no recent bill — enter those by hand.` : ''),
      );
      await load();
    } catch {
      setSyncMsg('Network error — please try again.');
    } finally {
      setRestoring(false);
    }
  }

  async function syncFromQb() {
    setSyncing(true); setSyncMsg(null);
    try {
      // Pull cost, retail, and stock from QuickBooks (the source of truth) and
      // import any items we don't have yet.
      const res = await fetch('/api/quickbooks/pull-inventory', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) { setSyncMsg(j.error || 'Sync failed.'); return; }
      setSyncMsg(
        `Synced ${j.updated} item${j.updated === 1 ? '' : 's'} (cost, retail & stock)` +
        (j.imported ? `, imported ${j.imported} new` : '') + ' from QuickBooks.',
      );
      await load();
    } catch {
      setSyncMsg('Network error — please try again.');
    } finally {
      setSyncing(false);
    }
  }

  // Push our cost/retail UP to QuickBooks (the reverse of the sync). Writes
  // live financial data, so confirm first.
  async function pushPricesToQb() {
    if (!confirm('Push the cost and retail prices shown here UP to QuickBooks for all items? This updates your live QuickBooks item prices.')) return;
    setPushing(true); setSyncMsg(null);
    try {
      const res = await fetch('/api/quickbooks/push-prices', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) { setSyncMsg(j.error || 'Push failed.'); return; }
      const errs = (j.errors || []).length;
      const noMatch = ((j.skipped as { reason: string }[]) || []).filter((s) => /no matching/i.test(s.reason)).length;
      setSyncMsg(
        `Pushed ${j.updated} item${j.updated === 1 ? '' : 's'} to QuickBooks` +
        `${errs ? `, ${errs} failed (${(j.errors as { qbName: string }[]).slice(0, 3).map((e) => e.qbName).join(', ')}${errs > 3 ? '…' : ''})` : ''}` +
        `${noMatch ? `, ${noMatch} had no matching QuickBooks item` : ''}.`,
      );
    } catch {
      setSyncMsg('Network error — please try again.');
    } finally {
      setPushing(false);
    }
  }

  async function load() {
    setLoading(true);
    const [invRes, prodRes] = await Promise.all([
      supabase
        .from('inventory_items')
        .select('id, qb_name, description, sku, packaging, cost, retail_price, taxable, qb_type, active, match_product_id, match_weight, match_container_size, qty_on_hand, qb_qty_synced_at, reorder_point, reorder_notify, admin_only')
        .order('packaging')
        .order('description'),
      // Mirror the ordering dropdowns; Fuel is excluded on purpose.
      supabase
        .from('products')
        .select('id, name, category, weights, container_sizes, sizes_by_weight')
        .eq('active', true)
        .neq('category', 'Fuel')
        .order('category')
        .order('name'),
    ]);
    setItems((invRes.data as Item[]) || []);
    setProducts((prodRes.data as CatProduct[]) || []);
    setLoading(false);
  }
  useEffect(() => {
    load();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setIsAdmin(data?.role === 'admin' || data?.role === 'master_admin');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setMatch(id: string, productId: string | null, weight: string | null, size: string | null) {
    setItems((prev) => prev.map((x) => (x.id === id
      ? { ...x, match_product_id: productId, match_weight: weight, match_container_size: size }
      : x)));
    await supabase
      .from('inventory_items')
      .update({ match_product_id: productId, match_weight: weight, match_container_size: size })
      .eq('id', id);
  }

  async function setActive(ids: string[], active: boolean) {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setItems((prev) => prev.map((x) => (set.has(x.id) ? { ...x, active } : x)));
    await supabase.from('inventory_items').update({ active }).in('id', ids);
  }

  async function setNum(id: string, field: 'cost' | 'retail_price' | 'reorder_point', value: number | null) {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
    await supabase.from('inventory_items').update({ [field]: value }).eq('id', id);
  }

  async function setNotify(id: string, value: boolean) {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, reorder_notify: value } : x)));
    await supabase.from('inventory_items').update({ reorder_notify: value }).eq('id', id);
  }

  async function setAdminOnly(id: string, value: boolean) {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, admin_only: value } : x)));
    await supabase.from('inventory_items').update({ admin_only: value }).eq('id', id);
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      // "Stock list" tab = only items reporting to the small list (active).
      // "All products" tab = the full QuickBooks catalog.
      if (tab === 'stock' && !it.active) return false;
      if (lowOnly && !isLow(it)) return false;
      if (!needle) return true;
      return `${it.description || ''} ${it.sku || ''} ${it.qb_name} ${it.packaging || ''}`.toLowerCase().includes(needle);
    });
  }, [items, q, lowOnly, tab]);

  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of filtered) {
      const k = packagingOf(it);
      const arr = m.get(k) || [];
      arr.push(it);
      m.set(k, arr);
    }
    return Array.from(m.entries()).sort((a, b) => {
      const ra = packagingSizeRank(a[0]);
      const rb = packagingSizeRank(b[0]);
      return ra !== rb ? ra - rb : a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  const activeCount = items.filter((i) => i.active).length;
  const lowCount = items.filter(isLow).length;
  // Categories + product names already in the Quick menu, for the per-item
  // "Add to Quick menu" control (category picker + duplicate guard).
  const productCategories = Array.from(new Set(products.map((p) => p.category))).sort();
  const quickMenuNames = new Set(products.map((p) => p.name.toLowerCase()));
  const lastSynced = items.reduce<string | null>(
    (acc, it) => (it.qb_qty_synced_at && (!acc || it.qb_qty_synced_at > acc) ? it.qb_qty_synced_at : acc),
    null,
  );

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="text-sm text-gray-500 mt-1">
          Full catalog pulled from QuickBooks. Toggle an item on to add it to your stock list.
          {' '}{activeCount} of {items.length} in stock list.
        </p>
      </div>

      {/* Tabs: curated stock list vs the full QuickBooks catalog */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {([
          ['stock', `Stock list (${activeCount})`],
          ['all', `All products (${items.length})`],
          ['adjust', 'Adjust counts'],
          ['costs', 'Cost history'],
          ['compare', 'Price comparison'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              tab === key
                ? 'border-brand-700 text-brand-700 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {editMenu && <QuickMenuEditor onClose={() => setEditMenu(false)} />}

      {tab !== 'costs' && tab !== 'compare' && (
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button
          onClick={syncFromQb}
          disabled={syncing}
          className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
        >
          {syncing ? 'Syncing…' : 'Sync prices & stock from QuickBooks'}
        </button>
        {isAdmin && (
          <button
            onClick={pushPricesToQb}
            disabled={pushing}
            className="px-3 py-2 text-sm border border-brand-700 text-brand-900 rounded-md hover:bg-brand-50 disabled:opacity-50 font-medium"
          >
            {pushing ? 'Pushing…' : 'Push prices to QuickBooks'}
          </button>
        )}
        {isAdmin && (
          <button
            onClick={restoreCosts}
            disabled={restoring}
            className="px-3 py-2 text-sm border border-amber-400 text-amber-800 rounded-md hover:bg-amber-50 disabled:opacity-50 font-medium"
          >
            {restoring ? 'Restoring…' : 'Restore missing costs from bills'}
          </button>
        )}
        <button
          onClick={() => setEditMenu(true)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 font-medium"
        >
          Edit Quick menu
        </button>
        {lastSynced && (
          <span className="text-xs text-gray-500">
            Last synced {new Date(lastSynced).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
        {lowCount > 0 && (
          <button
            onClick={() => setLowOnly((v) => !v)}
            className={`text-xs px-2 py-1 rounded-full font-medium ${lowOnly ? 'bg-red-600 text-white' : 'bg-red-100 text-red-800 hover:bg-red-200'}`}
          >
            {lowOnly ? 'Showing low stock' : `Low stock (${lowCount})`}
          </button>
        )}
        {syncMsg && <span className="text-xs text-gray-600">{syncMsg}</span>}
      </div>
      )}

      {tab === 'adjust' ? (
        <InventoryAdjustList />
      ) : tab === 'costs' ? (
        <CostHistory />
      ) : tab === 'compare' ? (
        <VendorPriceComparison />
      ) : (<>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, SKU, or packaging…"
        className="w-full max-w-md mb-4 px-3 py-2 border border-gray-300 rounded-md text-sm"
      />

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">
          No items yet — run the inventory seed in Supabase to import them.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([packaging, list]) => {
            const ids = list.map((i) => i.id);
            const allOn = list.every((i) => i.active);
            return (
              <div key={packaging} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">
                    {packaging} <span className="text-gray-400 font-normal">({list.length})</span>
                  </span>
                  <button
                    onClick={() => setActive(ids, !allOn)}
                    className="text-xs text-brand-700 hover:underline"
                  >
                    {allOn ? 'Turn all off' : 'Turn all on'}
                  </button>
                </div>
                <ul className="divide-y divide-gray-100">
                  {list.map((it) => (
                    <li key={it.id} className={`px-4 py-2 ${!it.active ? 'opacity-50' : ''}`}>
                      {/* Full description across the top — wraps, no truncation. */}
                      <div className="text-sm font-medium break-words mb-1">
                        {displayName(it)}
                        {!it.active && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">(off)</span>}
                        {it.admin_only && <span className="ml-2 text-[10px] uppercase tracking-wide text-brand-700">admin only</span>}
                      </div>
                      {/* SKU + flags + margin on one line. */}
                      <div className="text-xs text-gray-500 mb-1 overflow-x-auto whitespace-nowrap">
                        {it.sku ? `SKU ${it.sku}` : 'No SKU'}
                        {it.taxable ? ' · taxable' : ''}
                        {it.qb_type && it.qb_type !== 'Inventory' ? ` · ${it.qb_type}` : ''}
                        {isAdmin && it.cost != null && it.retail_price != null && it.retail_price > 0 && (
                          <span> · {Math.round(((it.retail_price - it.cost) / it.retail_price) * 100)}% margin</span>
                        )}
                      </div>
                      <div className="flex items-center justify-end gap-3 flex-wrap">
                        <div className="flex items-center gap-3 shrink-0">
                          {isAdmin && <PriceCell label="Cost" value={it.cost} onSave={(v) => setNum(it.id, 'cost', v)} />}
                          <PriceCell label="Retail" value={it.retail_price} onSave={(v) => setNum(it.id, 'retail_price', v)} />
                          {/* Toggle switch */}
                          <button
                            onClick={() => setActive([it.id], !it.active)}
                            role="switch"
                            aria-checked={it.active}
                            aria-label={`Toggle ${displayName(it)}`}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                              it.active ? 'bg-brand-700' : 'bg-gray-300'
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                                it.active ? 'translate-x-5' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap mt-1">
                        <span className={`text-xs ${isLow(it) ? 'text-red-700 font-semibold' : 'text-gray-500'}`}>
                          On hand: {it.qty_on_hand != null ? it.qty_on_hand : '—'}
                          {isLow(it) && <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 text-[10px] font-bold">LOW</span>}
                        </span>
                        <PriceCell label="Reorder at" value={it.reorder_point} money={false} onSave={(v) => setNum(it.id, 'reorder_point', v)} />
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input type="checkbox" checked={it.reorder_notify} onChange={(e) => setNotify(it.id, e.target.checked)} className="w-3.5 h-3.5" />
                          Notify me
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-gray-600" title="Only admins & master admins can see/order this item">
                          <input type="checkbox" checked={it.admin_only} onChange={(e) => setAdminOnly(it.id, e.target.checked)} className="w-3.5 h-3.5" />
                          Admin only
                        </label>
                      </div>
                      <VariantMatch
                        products={products}
                        item={it}
                        onSave={(pid, w, s) => setMatch(it.id, pid, w, s)}
                      />
                      <div className="mt-1">
                        <AddToQuickMenu
                          item={it}
                          categories={productCategories}
                          existingNames={quickMenuNames}
                          onAdded={load}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {groups.length === 0 && (
            <p className="text-sm text-gray-500">No items match “{q}”.</p>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}
