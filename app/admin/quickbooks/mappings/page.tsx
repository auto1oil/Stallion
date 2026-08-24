'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

type Product = {
  id: string;
  name: string;
  category: string;
  sort_order: number;
  container_sizes: string[] | null;
  weights: string[] | null;
  sizes_by_weight: Record<string, string[]> | null;
};

type QBItem = {
  id: string;
  name: string;
  unit_price: number | null;
};

type Mapping = {
  product_id: string;
  weight: string;
  container_size: string;
  qb_item_id: string;
  qb_item_name: string | null;
};

type Variant = {
  product_id: string;
  product_name: string;
  category: string;
  weight: string;            // empty string when product has no weights
  container_size: string;
  sort_key: number;
};

function variantsForProduct(p: Product): Variant[] {
  const variants: Variant[] = [];
  const sizesFor = (w: string): string[] => {
    if (w && p.sizes_by_weight && p.sizes_by_weight[w]?.length) return p.sizes_by_weight[w];
    return p.container_sizes ?? [];
  };
  const hasWeights = !!p.weights && p.weights.length > 0;
  if (!hasWeights) {
    for (const s of p.container_sizes ?? []) {
      variants.push({ product_id: p.id, product_name: p.name, category: p.category, weight: '', container_size: s, sort_key: p.sort_order });
    }
  } else {
    for (const w of p.weights!) {
      for (const s of sizesFor(w)) {
        variants.push({ product_id: p.id, product_name: p.name, category: p.category, weight: w, container_size: s, sort_key: p.sort_order });
      }
    }
  }
  return variants;
}

// Cheap fuzzy match — split each side into tokens, count overlaps.
function fuzzyScore(productLabel: string, qbItemName: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const a = norm(productLabel);
  const b = new Set(norm(qbItemName));
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits;
}

export default function QBMappingsPage() {
  const supabase = createClient();
  const [products, setProducts] = useState<Product[]>([]);
  const [qbItems, setQbItems] = useState<QBItem[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'mapped' | 'unmapped'>('unmapped');
  const [savingKey, setSavingKey] = useState<string>('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'table' | 'quick'>('table');
  const [autoMapping, setAutoMapping] = useState(false);
  const [autoMsg, setAutoMsg] = useState('');

  async function load() {
    setLoading(true);
    setLoadingItems(true);
    const [prodRes, mapRes, itemsRes] = await Promise.all([
      supabase
        .from('products')
        .select('id, name, category, sort_order, container_sizes, weights, sizes_by_weight')
        .eq('active', true)
        .order('sort_order'),
      supabase
        .from('product_qb_mapping')
        .select('product_id, weight, container_size, qb_item_id, qb_item_name'),
      fetch('/api/quickbooks/items').then((r) => r.json()),
    ]);

    setProducts((prodRes.data as Product[]) || []);
    setMappings((mapRes.data as Mapping[]) || []);
    if (itemsRes.ok) {
      setQbItems(itemsRes.items as QBItem[]);
    } else {
      setError(`Could not load QuickBooks items: ${itemsRes.error || 'unknown'}`);
    }
    setLoading(false);
    setLoadingItems(false);
  }

  useEffect(() => { load(); }, []);

  const variants: Variant[] = useMemo(() => {
    const all: Variant[] = [];
    products.forEach((p) => all.push(...variantsForProduct(p)));
    return all.sort((a, b) => a.sort_key - b.sort_key);
  }, [products]);

  const mapKey = (v: Variant) => `${v.product_id}|${v.weight}|${v.container_size}`;
  const mappingByKey = useMemo(() => {
    const m: Record<string, Mapping> = {};
    mappings.forEach((mp) => (m[`${mp.product_id}|${mp.weight}|${mp.container_size}`] = mp));
    return m;
  }, [mappings]);

  const filteredVariants = useMemo(() => {
    const term = search.trim().toLowerCase();
    return variants.filter((v) => {
      const hay = `${v.product_name} ${v.weight} ${v.container_size} ${v.category}`.toLowerCase();
      if (term && !hay.includes(term)) return false;
      const isMapped = !!mappingByKey[mapKey(v)];
      if (filter === 'mapped' && !isMapped) return false;
      if (filter === 'unmapped' && isMapped) return false;
      return true;
    });
  }, [variants, search, filter, mappingByKey]);

  function variantLabel(v: Variant): string {
    return [v.product_name, v.weight, v.container_size].filter(Boolean).join(' ');
  }

  // Update local state after a save — no full reload (which re-fetches all QB
  // items from the live API and was timing out on every click).
  async function setMapping(v: Variant, qbItemId: string) {
    const key = mapKey(v);
    setSavingKey(key);
    setError('');
    const qbItem = qbItems.find((i) => i.id === qbItemId);
    if (!qbItemId) {
      const { error: e } = await supabase
        .from('product_qb_mapping')
        .delete()
        .eq('product_id', v.product_id)
        .eq('weight', v.weight)
        .eq('container_size', v.container_size);
      if (e) { setError(e.message); setSavingKey(''); return; }
      setMappings((prev) => prev.filter(
        (m) => !(m.product_id === v.product_id && m.weight === v.weight && m.container_size === v.container_size),
      ));
    } else {
      const { error: e } = await supabase.from('product_qb_mapping').upsert(
        {
          product_id: v.product_id,
          weight: v.weight,
          container_size: v.container_size,
          qb_item_id: qbItemId,
          qb_item_name: qbItem?.name || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'product_id,weight,container_size' },
      );
      if (e) { setError(e.message); setSavingKey(''); return; }
      const row: Mapping = {
        product_id: v.product_id, weight: v.weight, container_size: v.container_size,
        qb_item_id: qbItemId, qb_item_name: qbItem?.name || null,
      };
      setMappings((prev) => {
        const rest = prev.filter(
          (m) => !(m.product_id === v.product_id && m.weight === v.weight && m.container_size === v.container_size),
        );
        return [...rest, row];
      });
    }
    setSavingKey('');
  }

  function suggestForVariant(v: Variant): QBItem[] {
    const label = variantLabel(v);
    return qbItems
      .map((qi) => ({ qi, score: fuzzyScore(label, qi.name) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => r.qi);
  }

  // Strongest suggestion + a confidence fraction (1 = every variant token found
  // in the QB item name). Used by quick-map and bulk auto-map.
  function bestSuggestion(v: Variant): { item: QBItem; score: number } | null {
    const label = variantLabel(v);
    const toks = label.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).length;
    let best: { item: QBItem; score: number } | null = null;
    for (const qi of qbItems) {
      const score = fuzzyScore(label, qi.name);
      if (!best || score > best.score) best = { item: qi, score };
    }
    if (!best || best.score === 0) return null;
    return { item: best.item, score: toks ? best.score / toks : 0 };
  }

  async function autoMapExact() {
    setAutoMapping(true); setAutoMsg(''); setError('');
    const rows: Mapping[] = [];
    for (const v of variants.filter((x) => !mappingByKey[mapKey(x)])) {
      const b = bestSuggestion(v);
      if (b && b.score >= 0.99) {
        rows.push({ product_id: v.product_id, weight: v.weight, container_size: v.container_size, qb_item_id: b.item.id, qb_item_name: b.item.name });
      }
    }
    if (rows.length === 0) { setAutoMapping(false); setAutoMsg('No exact matches to auto-map.'); return; }
    const { error: e } = await supabase.from('product_qb_mapping').upsert(
      rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: 'product_id,weight,container_size' },
    );
    if (e) { setError(e.message); setAutoMapping(false); return; }
    setMappings((prev) => {
      const keyset = new Set(rows.map((r) => `${r.product_id}|${r.weight}|${r.container_size}`));
      return [...prev.filter((m) => !keyset.has(`${m.product_id}|${m.weight}|${m.container_size}`)), ...rows];
    });
    setAutoMapping(false);
    setAutoMsg(`Auto-mapped ${rows.length} exact match${rows.length === 1 ? '' : 'es'}.`);
  }

  const mappedCount = variants.filter((v) => mappingByKey[mapKey(v)]).length;

  return (
    <div>
      <div className="mb-4">
        <Link href="/admin/quickbooks" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to QuickBooks settings
        </Link>
      </div>

      <h1 className="text-2xl font-semibold mb-1">Map products to QB items</h1>
      <p className="text-sm text-gray-500 mb-4">
        Each row is one product variant your customers can order. Pick which item in
        your real QuickBooks it maps to so invoices use the right SKU + price.
        Unmapped variants will auto-create a new $0 item in QB on first use (not ideal).
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-900 rounded-md p-3 mb-3 text-sm">{error}</div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4 space-y-3">
        <input
          type="text"
          placeholder="Search by product name, weight, or size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
        />
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-medium text-gray-600">Show:</span>
          {(['unmapped', 'all', 'mapped'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md border ${
                filter === f ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f === 'unmapped' ? 'Needs mapping' : f === 'mapped' ? 'Already mapped' : 'All'}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-auto">
            {mappedCount} of {variants.length} mapped · {qbItems.length} QB items loaded
            {loadingItems && ' · refreshing…'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 items-center border-t border-gray-100 pt-3">
          <span className="text-xs font-medium text-gray-600">Mode:</span>
          {(['table', 'quick'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs rounded-md border ${
                mode === m ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-gray-300 hover:bg-gray-50'
              }`}
            >
              {m === 'table' ? 'Table' : 'Quick map (fast)'}
            </button>
          ))}
          <button
            onClick={autoMapExact}
            disabled={autoMapping}
            className="px-3 py-1 text-xs rounded-md border border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 ml-auto"
          >
            {autoMapping ? 'Auto-mapping…' : '⚡ Auto-map exact matches'}
          </button>
          {autoMsg && <span className="text-xs text-gray-600 w-full">{autoMsg}</span>}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : filteredVariants.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">
          {filter === 'unmapped' && mappedCount === variants.length
            ? 'Everything is mapped. Switch the filter to "All" or "Already mapped" to review.'
            : 'No matching variants.'}
        </p>
      ) : mode === 'quick' ? (
        <div className="space-y-2">
          {filteredVariants.map((v) => {
            const k = mapKey(v);
            const current = mappingByKey[k];
            const isSaving = savingKey === k;
            const best = !current ? bestSuggestion(v) : null;
            const sugg = !current ? suggestForVariant(v) : [];
            return (
              <div key={k} className="bg-white border border-gray-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{v.product_name}</div>
                  <div className="text-xs text-gray-500">{[v.weight, v.container_size].filter(Boolean).join(' · ')}</div>
                  {current && <div className="text-xs text-emerald-700 mt-0.5">✓ {current.qb_item_name}</div>}
                </div>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {best && (
                    <button
                      onClick={() => setMapping(v, best.item.id)}
                      disabled={isSaving}
                      className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium max-w-[60vw] truncate"
                      title={best.item.name}
                    >
                      ✓ {best.item.name}
                    </button>
                  )}
                  {sugg.slice(1).map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setMapping(v, s.id)}
                      disabled={isSaving}
                      className="px-2 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 max-w-[40vw] truncate"
                      title={s.name}
                    >
                      {s.name}
                    </button>
                  ))}
                  <select
                    value={current?.qb_item_id || ''}
                    onChange={(e) => setMapping(v, e.target.value)}
                    disabled={isSaving}
                    className="px-2 py-1.5 border border-gray-300 rounded-md text-xs bg-white max-w-[40vw]"
                  >
                    <option value="">{current ? 'change…' : 'pick manually…'}</option>
                    {qbItems.map((qi) => (
                      <option key={qi.id} value={qi.id}>{qi.name}</option>
                    ))}
                  </select>
                  {current && (
                    <button onClick={() => setMapping(v, '')} disabled={isSaving} className="text-xs text-red-600 hover:underline">clear</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-xs uppercase tracking-wide text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">Variant</th>
                <th className="text-left px-3 py-2">QB item</th>
                <th className="text-left px-3 py-2">Price</th>
              </tr>
            </thead>
            <tbody>
              {filteredVariants.map((v) => {
                const k = mapKey(v);
                const current = mappingByKey[k];
                const isSaving = savingKey === k;
                const suggestions = !current ? suggestForVariant(v) : [];
                const currentItem = current ? qbItems.find((i) => i.id === current.qb_item_id) : null;
                return (
                  <tr key={k} className="border-b border-gray-100 last:border-b-0 align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{v.product_name}</div>
                      <div className="text-xs text-gray-500">
                        {[v.weight, v.container_size].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={current?.qb_item_id || ''}
                        onChange={(e) => setMapping(v, e.target.value)}
                        disabled={isSaving}
                        className="w-full px-2 py-1 border border-gray-300 rounded-md text-sm bg-white max-w-xs"
                      >
                        <option value="">— not mapped (auto-create) —</option>
                        {qbItems.map((qi) => (
                          <option key={qi.id} value={qi.id}>{qi.name}</option>
                        ))}
                      </select>
                      {suggestions.length > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          Suggested:{' '}
                          {suggestions.map((s, i) => (
                            <span key={s.id}>
                              {i > 0 && ' · '}
                              <button onClick={() => setMapping(v, s.id)} className="text-brand-700 hover:underline">
                                {s.name}
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm tabular-nums whitespace-nowrap">
                      {currentItem?.unit_price != null
                        ? `$${currentItem.unit_price.toFixed(2)}`
                        : <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
