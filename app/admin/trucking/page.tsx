'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import TruckingCreate from '@/components/TruckingCreate';

// Admin Trucking setup: manage the freight lanes/rates, the QuickBooks customer
// + items freight invoices use, and the fuel-surcharge % (auto from the weekly
// EIA diesel price, with a manual override). Drivers get the simple create form
// under /driver/trucking (Stage 2).

type Lane = { id?: string; origin: string; destination: string; rate: string; sort_order: number; active: boolean };
type Commodity = { id?: string; name: string; qb_item_id: string; applies_surcharge: boolean; pricing_mode: string; active: boolean; sort_order: number };
type QBItem = { id: string; name: string; unit_price: number | null };
type Settings = {
  qbCustomerId: string; qbCustomerName: string;
  qbFreightItemId: string; qbFreightItemName: string;
  qbSurchargeItemId: string; qbSurchargeItemName: string;
  manualPct: number | null; basePrice: number; step: number;
  fuelPrice: number | null; fuelPricePeriod: string | null;
  computedPct: number; effectivePct: number;
};

export default function AdminTruckingPage() {
  const supabase = createClient();
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [customers, setCustomers] = useState<{ id: string; qb_customer_id: string; qb_customer_name: string; active: boolean }[]>([]);
  const [items, setItems] = useState<QBItem[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [view, setView] = useState<'create' | 'setup'>('create');

  // Editable copies of the settings fields.
  const [surchargeItemId, setSurchargeItemId] = useState('');
  const [manualPct, setManualPct] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Customer typeahead (auto-searches as you type).
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<{ id: string; name: string }[]>([]);
  const [custSearching, setCustSearching] = useState(false);
  const [custSearched, setCustSearched] = useState(false);
  const [custErr, setCustErr] = useState('');

  const loadLanes = useCallback(async () => {
    const { data } = await supabase
      .from('trucking_lanes')
      .select('id, origin, destination, rate_per_gallon, sort_order, active')
      .order('sort_order', { ascending: true });
    setLanes(((data as { id: string; origin: string; destination: string; rate_per_gallon: number; sort_order: number; active: boolean }[]) || [])
      .map((l) => ({ id: l.id, origin: l.origin, destination: l.destination, rate: String(l.rate_per_gallon), sort_order: l.sort_order, active: l.active !== false })));
  }, [supabase]);

  const loadCommodities = useCallback(async () => {
    const { data } = await supabase
      .from('trucking_commodities')
      .select('id, name, qb_item_id, applies_surcharge, pricing_mode, active, sort_order')
      .order('sort_order', { ascending: true });
    setCommodities(((data as { id: string; name: string; qb_item_id: string | null; applies_surcharge: boolean; pricing_mode: string | null; active: boolean; sort_order: number }[]) || [])
      .map((c) => ({ id: c.id, name: c.name, qb_item_id: c.qb_item_id || '', applies_surcharge: c.applies_surcharge !== false, pricing_mode: c.pricing_mode || 'lane', active: c.active !== false, sort_order: c.sort_order })));
  }, [supabase]);

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('trucking_customers')
      .select('id, qb_customer_id, qb_customer_name, active')
      .order('sort_order', { ascending: true });
    setCustomers((data as { id: string; qb_customer_id: string; qb_customer_name: string; active: boolean }[]) || []);
  }, [supabase]);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/trucking/settings');
    const j = await res.json();
    if (j.ok) {
      const s = j.settings as Settings;
      setSettings(s);
      setSurchargeItemId(s.qbSurchargeItemId);
      setManualPct(s.manualPct == null ? '' : String(s.manualPct));
    } else setErr(j.error || 'Failed to load settings');
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([
        loadLanes(),
        loadCommodities(),
        loadCustomers(),
        loadSettings(),
        fetch('/api/quickbooks/items').then((r) => r.json()).then((j) => {
          if (j.ok) setItems((j.items as QBItem[]).sort((a, b) => a.name.localeCompare(b.name)));
        }).catch(() => {}),
      ]);
      setLoading(false);
    })();
  }, [loadLanes, loadCommodities, loadCustomers, loadSettings]);

  // Commodity row editing.
  function setCommodity(i: number, patch: Partial<Commodity>) {
    setCommodities((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addCommodity() {
    setCommodities((prev) => [...prev, { name: '', qb_item_id: '', applies_surcharge: true, pricing_mode: 'lane', active: true, sort_order: (prev.at(-1)?.sort_order ?? 0) + 1 }]);
  }
  function removeCommodity(i: number) {
    setCommodities((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function saveCommodities() {
    setErr(''); setMsg('');
    const rows = commodities
      .filter((c) => c.name.trim())
      .map((c, idx) => {
        const it = items.find((i) => i.id === c.qb_item_id);
        return {
          name: c.name.trim(),
          qb_item_id: c.qb_item_id || null,
          qb_item_name: it?.name || null,
          qb_item_price: it?.unit_price ?? null,   // cached for 'quantity' mode
          applies_surcharge: c.pricing_mode === 'lane' ? c.applies_surcharge : false,
          pricing_mode: c.pricing_mode,
          active: c.active,
          sort_order: idx + 1,
        };
      });
    const del = await supabase.from('trucking_commodities').delete().not('id', 'is', null);
    if (del.error) { setErr(del.error.message); return; }
    if (rows.length) {
      const ins = await supabase.from('trucking_commodities').insert(rows);
      if (ins.error) { setErr(ins.error.message); return; }
    }
    setMsg('Commodities saved.');
    await loadCommodities();
  }

  // Lane row editing.
  function setLane(i: number, patch: Partial<Lane>) {
    setLanes((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLane() {
    setLanes((prev) => [...prev, { origin: '', destination: '', rate: '', sort_order: (prev.at(-1)?.sort_order ?? 0) + 1, active: true }]);
  }
  function removeLane(i: number) {
    setLanes((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function saveLanes() {
    setErr(''); setMsg('');
    const rows = lanes
      .filter((l) => l.origin.trim() && l.destination.trim())
      .map((l, idx) => ({ origin: l.origin.trim(), destination: l.destination.trim(), rate_per_gallon: Number(l.rate) || 0, sort_order: idx + 1, active: l.active }));
    // Full replace, like the fuel-tier editor.
    const del = await supabase.from('trucking_lanes').delete().not('id', 'is', null);
    if (del.error) { setErr(del.error.message); return; }
    if (rows.length) {
      const ins = await supabase.from('trucking_lanes').insert(rows);
      if (ins.error) { setErr(ins.error.message); return; }
    }
    setMsg('Lanes saved.');
    await loadLanes();
  }

  // Customer search — auto-runs (debounced) as you type, with clear feedback.
  useEffect(() => {
    const q = custQuery.trim();
    if (q.length < 2) { setCustResults([]); setCustSearched(false); setCustErr(''); return; }
    setCustSearching(true);
    const t = setTimeout(async () => {
      try {
        const j = await fetch(`/api/quickbooks/customers?q=${encodeURIComponent(q)}`).then((r) => r.json());
        if (j.ok) { setCustResults(j.customers); setCustErr(''); }
        else { setCustResults([]); setCustErr(j.error || 'Search failed'); }
      } catch { setCustResults([]); setCustErr('Network error'); }
      finally { setCustSearching(false); setCustSearched(true); }
    }, 350);
    return () => clearTimeout(t);
  }, [custQuery]);
  async function addCustomer(c: { id: string; name: string }) {
    setErr(''); setMsg('');
    if (customers.some((x) => x.qb_customer_id === c.id)) { setCustQuery(''); setCustResults([]); return; }
    const { error } = await supabase.from('trucking_customers')
      .insert({ qb_customer_id: c.id, qb_customer_name: c.name, sort_order: customers.length + 1 });
    if (error) { setErr(error.message); return; }
    setCustQuery(''); setCustResults([]); setCustSearched(false);
    await loadCustomers();
  }
  async function toggleCustomer(id: string, active: boolean) {
    const { error } = await supabase.from('trucking_customers').update({ active }).eq('id', id);
    if (error) { setErr(error.message); return; }
    await loadCustomers();
  }
  async function deleteCustomer(id: string) {
    const { error } = await supabase.from('trucking_customers').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    await loadCustomers();
  }

  async function saveSettings() {
    setSavingSettings(true); setErr(''); setMsg('');
    const surcharge = items.find((i) => i.id === surchargeItemId);
    const body = {
      qbSurchargeItemId: surchargeItemId, qbSurchargeItemName: surcharge?.name || '',
      manualPct: manualPct.trim(),
    };
    const j = await fetch('/api/trucking/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    setSavingSettings(false);
    if (!j.ok) { setErr(j.error || 'Save failed'); return; }
    setSettings(j.settings); setMsg('Settings saved.');
  }

  async function refreshEia() {
    setRefreshing(true); setErr(''); setMsg('');
    const j = await fetch('/api/cron/fetch-eia', { method: 'POST' }).then((r) => r.json());
    setRefreshing(false);
    if (!j.ok) { setErr(j.error || 'EIA refresh failed'); return; }
    setMsg(`Pulled EIA price $${Number(j.price).toFixed(3)} (week of ${j.period}).`);
    await loadSettings();
  }

  const inputCls = 'w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none';
  const label = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1';

  const setupComplete = useMemo(
    () => !!(settings && settings.qbSurchargeItemId
      && customers.some((c) => c.active)
      && commodities.some((c) => c.active && c.qb_item_id)),
    [settings, customers, commodities],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Trucking</h1>
      </div>

      {/* Admins land on Create invoice (to see/test how invoices get made),
          with a toggle into the setup screen. */}
      <div className="flex gap-1 border-b border-gray-200">
        {([['create', 'Create invoice'], ['setup', 'Trucking setup']] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setView(k)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${view === k ? 'border-brand-700 text-brand-700 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {view === 'create' && <TruckingCreate orderHrefBase="/admin/deliver" />}

      {view === 'setup' && (loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
      <div className="space-y-6">
      <div>
        <p className="text-sm text-gray-500">
          Freight lanes, the QuickBooks customers &amp; items freight invoices use, and the
          fuel surcharge that drivers get when they create a trucking invoice.
        </p>
      </div>

      {(msg || err) && (
        <div className={`rounded-md border text-sm px-3 py-2 ${err ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {err || msg}
        </div>
      )}

      {!setupComplete && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          Finish setup below: add at least one bill-to <strong>customer</strong>, pick the
          {' '}<strong>fuel-surcharge</strong> QuickBooks item, and map at least one <strong>commodity</strong> to a
          QuickBooks item. Until then, drivers can&apos;t create trucking invoices.
        </div>
      )}

      {/* Fuel surcharge */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Fuel surcharge</h2>
          <button onClick={refreshEia} disabled={refreshing}
            className="text-sm rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50">
            {refreshing ? 'Refreshing…' : 'Refresh from EIA'}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className={label}>Latest EIA ULSD</div>
            <div className="text-gray-900">{settings?.fuelPrice != null ? `$${settings.fuelPrice.toFixed(3)}` : '—'}</div>
            <div className="text-xs text-gray-400">{settings?.fuelPricePeriod ? `week of ${settings.fuelPricePeriod}` : 'no price yet'}</div>
          </div>
          <div>
            <div className={label}>Computed %</div>
            <div className="text-gray-900">{settings ? `${settings.computedPct}%` : '—'}</div>
            <div className="text-xs text-gray-400">ceil((price − ${settings?.basePrice ?? 3}) / ${settings?.step ?? 0.15})</div>
          </div>
          <div>
            <div className={label}>Manual override %</div>
            <input value={manualPct} onChange={(e) => setManualPct(e.target.value)} placeholder="auto" className={inputCls} />
            <div className="text-xs text-gray-400">blank = use computed</div>
          </div>
          <div>
            <div className={label}>Applied to invoices</div>
            <div className="text-2xl font-bold text-brand-700">{settings ? `${settings.effectivePct}%` : '—'}</div>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          Rocky Mountain (PADD 4) Ultra-Low-Sulfur diesel. Auto-updates weekly; set
          <code className="mx-1">EIA_API_KEY</code> in Vercel for the automatic pull, or use the manual override.
        </p>
      </section>

      {/* QuickBooks mapping */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 space-y-4">
        <h2 className="font-semibold text-gray-900">QuickBooks</h2>

        <div>
          <div className={label}>Bill-to customers</div>
          <p className="text-xs text-gray-400 mb-2">The customers a driver can pick from when creating a trucking invoice.</p>

          {customers.length > 0 && (
            <ul className="mb-3 border border-gray-200 rounded-md divide-y divide-gray-100">
              {customers.map((c) => (
                <li key={c.id} className={`flex items-center gap-3 px-3 py-2 text-sm ${c.active ? '' : 'opacity-50'}`}>
                  <input type="checkbox" checked={c.active} onChange={(e) => toggleCustomer(c.id, e.target.checked)} className="h-4 w-4 accent-brand-600" title={c.active ? 'Available to drivers' : 'Hidden from drivers'} />
                  <span className="flex-1 text-gray-900">{c.qb_customer_name}</span>
                  <button onClick={() => deleteCustomer(c.id)} className="text-xs text-gray-300 hover:text-red-600">Remove</button>
                </li>
              ))}
            </ul>
          )}

          <input value={custQuery} onChange={(e) => setCustQuery(e.target.value)}
            placeholder="Add a customer — type a name (e.g. Little America)…" className={inputCls} autoComplete="off" />
          <div className="mt-2">
            {custSearching && <p className="text-xs text-gray-400 px-1">Searching QuickBooks…</p>}
            {!custSearching && custErr && <p className="text-xs text-red-600 px-1">{custErr}</p>}
            {!custSearching && !custErr && custSearched && custResults.length === 0 && (
              <p className="text-xs text-gray-400 px-1">No matching customers. Try a shorter or different spelling.</p>
            )}
            {custResults.length > 0 && (
              <ul className="border border-gray-200 rounded-md divide-y divide-gray-100 max-h-48 overflow-auto">
                {custResults.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => addCustomer(c)} className="w-full text-left px-3 py-1.5 text-sm hover:bg-brand-50">+ {c.name}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="sm:max-w-sm">
          <div className={label}>Fuel-surcharge line item</div>
          <select value={surchargeItemId} onChange={(e) => setSurchargeItemId(e.target.value)} className={inputCls}>
            <option value="">— pick a QB item —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <div className="text-xs text-gray-400 mt-1">The &quot;Fuel Surcharge&quot; line added on top (freight items are set up under Commodities below).</div>
        </div>
        {items.length === 0 && <p className="text-xs text-amber-700">Couldn&apos;t load QuickBooks items — check the QB connection, then reload.</p>}

        <div className="flex justify-end">
          <button onClick={saveSettings} disabled={savingSettings}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 disabled:opacity-50">
            {savingSettings ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </section>

      {/* Commodities */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Commodities</h2>
          <button onClick={addCommodity} className="text-sm text-brand-700 hover:underline">+ Add commodity</button>
        </div>
        <p className="text-xs text-gray-400">
          What the driver picks (one at a time) when creating a trucking invoice. Map each to a
          QuickBooks item. <strong>Fuel surcharge</strong> is only added for the commodities you check.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-2 py-1 text-center">Active</th>
                <th className="px-2 py-1">Name (shown to driver)</th>
                <th className="px-2 py-1">QuickBooks item</th>
                <th className="px-2 py-1">Priced by</th>
                <th className="px-2 py-1 text-center">Surcharge</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {commodities.map((c, i) => (
                <tr key={c.id || `new-${i}`} className={c.active ? '' : 'opacity-50'}>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={c.active} onChange={(e) => setCommodity(i, { active: e.target.checked })} className="h-4 w-4 accent-brand-600" />
                  </td>
                  <td className="px-2 py-1"><input value={c.name} onChange={(e) => setCommodity(i, { name: e.target.value })} className={inputCls} /></td>
                  <td className="px-2 py-1">
                    <select value={c.qb_item_id} onChange={(e) => setCommodity(i, { qb_item_id: e.target.value })} className={inputCls}>
                      <option value="">— pick a QB item —</option>
                      {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select value={c.pricing_mode} onChange={(e) => setCommodity(i, { pricing_mode: e.target.value })} className={inputCls}>
                      <option value="lane">Gallons × lane rate</option>
                      <option value="quantity">Weight × item price</option>
                      <option value="amount">Rate (flat amount)</option>
                    </select>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={c.applies_surcharge} disabled={c.pricing_mode !== 'lane'}
                      onChange={(e) => setCommodity(i, { applies_surcharge: e.target.checked })}
                      className="h-4 w-4 accent-brand-600 disabled:opacity-40" title="Fuel surcharge applies (lane-priced only)" />
                  </td>
                  <td className="px-2 py-1 text-right"><button onClick={() => removeCommodity(i)} className="text-xs text-gray-300 hover:text-red-600">Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && <p className="text-xs text-amber-700">Couldn&apos;t load QuickBooks items — check the QB connection, then reload.</p>}
        <div className="flex justify-end">
          <button onClick={saveCommodities} className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2">Save commodities</button>
        </div>
      </section>

      {/* Lanes */}
      <section className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Lanes &amp; base rates</h2>
          <button onClick={addLane} className="text-sm text-brand-700 hover:underline">+ Add lane</button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-2 py-1 text-center">Active</th>
                <th className="px-2 py-1">Pickup (origin)</th>
                <th className="px-2 py-1">Destination</th>
                <th className="px-2 py-1">Base $/gal</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((l, i) => (
                <tr key={l.id || `new-${i}`} className={l.active ? '' : 'opacity-50'}>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={l.active} onChange={(e) => setLane(i, { active: e.target.checked })}
                      className="h-4 w-4 accent-brand-600" title={l.active ? 'Shown to drivers' : 'Hidden from drivers'} />
                  </td>
                  <td className="px-2 py-1"><input value={l.origin} onChange={(e) => setLane(i, { origin: e.target.value })} className={inputCls} /></td>
                  <td className="px-2 py-1"><input value={l.destination} onChange={(e) => setLane(i, { destination: e.target.value })} className={inputCls} /></td>
                  <td className="px-2 py-1"><input inputMode="decimal" value={l.rate} onChange={(e) => setLane(i, { rate: e.target.value })} className={`${inputCls} w-28`} /></td>
                  <td className="px-2 py-1 text-right"><button onClick={() => removeLane(i)} className="text-xs text-gray-300 hover:text-red-600">Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end">
          <button onClick={saveLanes} className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2">Save lanes</button>
        </div>
      </section>
      </div>
      ))}
    </div>
  );
}
