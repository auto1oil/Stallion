'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

// Shared trucking create-invoice + en-route flow, used by both the driver
// Trucking tab and the admin Trucking tab. `orderHrefBase` controls where an
// en-route row links to (driver vs admin deliver screen).

type Lane = { id: string; origin: string; destination: string; rate: number };
type Commodity = { id: string; name: string; mode: 'lane' | 'quantity' | 'amount'; appliesSurcharge: boolean; unitPrice: number | null };
type Customer = { id: string; name: string };
type Term = { id: string; name: string };
type Rates = { lanes: Lane[]; commodities: Commodity[]; customers: Customer[]; terms: Term[]; surchargePct: number; fuelPrice: number | null; setupComplete: boolean };
type TruckOrder = {
  id: string; date: string; invoice_number: string | null; bol_number: string | null;
  status: string; notes: string | null; delivered: boolean | null; bol_pdf_path: string | null;
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Same cents rounding QuickBooks uses, so the preview matches the invoice.
function lineAmount(rate: number, qty: number): number {
  return Math.round((Math.round(rate * 1e5) * qty) / 1e3) / 100;
}

export default function TruckingCreate({ orderHrefBase = '/driver/order' }: { orderHrefBase?: string }) {
  const supabase = createClient();
  const [tab, setTab] = useState<'create' | 'out' | 'delivered'>('create');
  const [rates, setRates] = useState<Rates | null>(null);
  const [orders, setOrders] = useState<TruckOrder[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state. Multiple products can go on one invoice (e.g. gasoline + diesel),
  // each with its own amount input (`vals` keyed by commodity id).
  const [customerId, setCustomerId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vals, setVals] = useState<Record<string, string>>({});
  const [termId, setTermId] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [bol, setBol] = useState('');
  const [bolPath, setBolPath] = useState('');   // uploaded BOL file (storage path)
  const [bolName, setBolName] = useState('');
  const [bolUploading, setBolUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ invoice: string; bolWarn?: boolean } | null>(null);

  const loadOrders = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select('id, date, invoice_number, bol_number, status, notes, delivered, bol_pdf_path')
      .eq('type', 'Trucking')
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    setOrders((data as TruckOrder[]) || []);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      await Promise.all([
        fetch('/api/trucking/rates').then((r) => r.json()).then((j) => { if (j.ok) setRates(j); }).catch(() => {}),
        loadOrders(),
      ]);
      setLoading(false);
    })();
  }, [loadOrders]);

  const origins = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const l of rates?.lanes || []) if (!seen.has(l.origin)) { seen.add(l.origin); out.push(l.origin); }
    return out;
  }, [rates]);
  const destinations = useMemo(
    () => (rates?.lanes || []).filter((l) => l.origin === origin).map((l) => l.destination),
    [rates, origin],
  );
  const lane = useMemo(
    () => (rates?.lanes || []).find((l) => l.origin === origin && l.destination === destination) || null,
    [rates, origin, destination],
  );

  // Customers listed alphabetically (there can be many).
  const sortedCustomers = useMemo(
    () => [...(rates?.customers || [])].sort((a, b) => a.name.localeCompare(b.name)),
    [rates],
  );

  const selectedCommodities = useMemo(
    () => (rates?.commodities || []).filter((c) => selected.has(c.id)),
    [rates, selected],
  );
  const anyLane = selectedCommodities.some((c) => c.mode === 'lane');

  const freightFor = (c: Commodity): number => {
    const v = Number(vals[c.id]);
    if (!(v > 0)) return 0;
    if (c.mode === 'lane') return lane ? lineAmount(lane.rate, v) : 0;
    if (c.mode === 'quantity') return c.unitPrice != null ? lineAmount(c.unitPrice, v) : 0;
    return Math.round(v * 100) / 100; // amount
  };
  const freight = selectedCommodities.reduce((s, c) => s + freightFor(c), 0);
  const surchargeBase = selectedCommodities.filter((c) => c.mode === 'lane' && c.appliesSurcharge).reduce((s, c) => s + freightFor(c), 0);
  const pct = rates?.surchargePct ?? 0;
  const surcharge = surchargeBase > 0 && pct > 0 ? lineAmount(pct / 100, surchargeBase) : 0;
  const total = freight + surcharge;
  const canSubmit = !!customerId
    && selectedCommodities.length > 0
    && selectedCommodities.every((c) => Number(vals[c.id]) > 0)
    && (anyLane ? !!lane : true);

  // Upload a BOL file (PDF or photo) to the invoices bucket; store the path.
  async function onBolFile(file: File | null) {
    if (!file) return;
    setErr(''); setBolUploading(true);
    const ext = (file.name.split('.').pop() || 'dat').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `trucking-bol/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from('invoices').upload(path, file, { contentType: file.type || undefined, upsert: false });
    setBolUploading(false);
    if (error) { setErr('Could not upload the BOL: ' + error.message); return; }
    setBolPath(path); setBolName(file.name);
  }
  async function viewBol(path: string) {
    const { data } = await supabase.storage.from('invoices').createSignedUrl(path, 600);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }

  function toggleProduct(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const unitLabel = (m: string) => (m === 'lane' ? 'Gallons' : m === 'quantity' ? 'Weight' : 'Rate ($)');

  async function submit() {
    setErr(''); setDone(null);
    if (!customerId) { setErr('Pick a customer.'); return; }
    if (selectedCommodities.length === 0) { setErr('Pick at least one product.'); return; }
    for (const c of selectedCommodities) {
      if (!(Number(vals[c.id]) > 0)) { setErr(`Enter the ${unitLabel(c.mode).toLowerCase()} for ${c.name}.`); return; }
    }
    if (anyLane && !lane) { setErr('Pick a pickup and destination.'); return; }
    const payload: Record<string, unknown> = {
      customer_id: customerId,
      bol_number: bol.trim(),
      bol_path: bolPath,
      term_id: termId,
      items: selectedCommodities.map((c) => ({ commodity_id: c.id, value: Number(vals[c.id]) })),
    };
    if (anyLane && lane) payload.lane_id = lane.id;
    setSubmitting(true);
    const j = await fetch('/api/trucking/invoice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Network error' }));
    setSubmitting(false);
    if (!j.ok) { setErr(j.error || 'Could not create the invoice.'); return; }
    // The QB invoice was created but the app row didn't save — surface it loudly
    // (usually the trucking DB migration hasn't been run). Do NOT recreate it.
    if (j.warning) {
      setErr(`Invoice #${j.invoice_number} was created in QuickBooks but couldn't be saved into the app: ${j.warning} — don't recreate it; an admin needs to run the trucking database update.`);
      await loadOrders();
      return;
    }
    setDone({ invoice: String(j.invoice_number), bolWarn: !!j.bol_attach_failed });
    setCustomerId(''); setSelected(new Set()); setVals({}); setTermId(''); setBol(''); setBolPath(''); setBolName(''); setOrigin(''); setDestination('');
    await loadOrders();
    setTab('out');
  }

  const inputCls = 'w-full rounded-md border border-gray-300 px-3 py-2 text-base focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none';
  const label = 'block text-sm font-semibold text-gray-700 mb-1';
  const box = (on: boolean) => `flex items-center gap-2 text-left rounded-lg border px-3 py-3 text-base transition-colors ${on ? 'border-brand-600 bg-brand-50 text-brand-800 font-semibold' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`;
  const dot = (on: boolean) => `inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-bold ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-300 text-transparent'}`;
  const enroute = orders.filter((o) => o.status !== 'delivered' && !o.delivered);
  const delivered = orders.filter((o) => o.status === 'delivered' || o.delivered);

  function OrderRow({ o }: { o: TruckOrder }) {
    return (
      <div className="rounded-lg border-2 border-orange-400 bg-white shadow-sm">
        <Link href={`${orderHrefBase}/${o.id}`} className="block px-4 py-3 hover:bg-orange-50">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-gray-900">Invoice #{o.invoice_number || '—'}</span>
            <span className="text-xs uppercase tracking-wide text-gray-500">
              {o.status === 'delivered' || o.delivered ? 'Delivered' : o.status === 'out_for_delivery' ? 'Out for delivery' : 'Ready'}
            </span>
          </div>
          <div className="text-sm text-gray-600 mt-0.5">{(o.notes || '').replace(/^Trucking:\s*/, '')}</div>
          {o.bol_number && <div className="text-xs text-gray-400 mt-0.5">BOL# {o.bol_number}</div>}
        </Link>
        {o.bol_pdf_path && (
          <div className="px-4 pb-2 -mt-1">
            <button type="button" onClick={() => viewBol(o.bol_pdf_path!)} className="text-xs text-brand-700 underline">📎 View BOL document</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {([['create', 'Create invoice'], ['out', `Out for delivery${enroute.length ? ` (${enroute.length})` : ''}`], ['delivered', `Delivered${delivered.length ? ` (${delivered.length})` : ''}`]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === k ? 'border-brand-700 text-brand-700 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {!loading && tab === 'create' && (
        <div className="space-y-4">
          {rates && !rates.setupComplete && (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
              Trucking isn&apos;t set up yet — finish the Trucking setup (customers, fuel-surcharge item, and mapped commodities) before invoices can be created.
            </div>
          )}
          {done && (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">
              Invoice <strong>#{done.invoice}</strong> created. It&apos;s now Out for delivery.
            </div>
          )}
          {done?.bolWarn && (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
              ⚠️ The BOL couldn&apos;t be attached to the QuickBooks invoice — it&apos;s still saved here on the order. Attach it in QuickBooks by hand if you need it on the invoice.
            </div>
          )}
          {err && <div className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

          <div>
            <label className={label}>Customer</label>
            {/* Scrollable, alphabetical — tap one. */}
            <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 p-2 space-y-2">
              {sortedCustomers.map((c) => (
                <button key={c.id} type="button" onClick={() => setCustomerId(c.id)} className={`${box(customerId === c.id)} w-full`}>
                  <span className={dot(customerId === c.id)}>{customerId === c.id ? '✓' : ''}</span>
                  {c.name}
                </button>
              ))}
              {sortedCustomers.length === 0 && <p className="text-sm text-gray-400 px-1 py-2">No customers set up yet.</p>}
            </div>
          </div>

          {/* Products — tap one or more (e.g. gasoline + diesel on the same load). */}
          <div>
            <label className={label}>Products</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(rates?.commodities || []).map((c) => (
                <button key={c.id} type="button" onClick={() => toggleProduct(c.id)} className={box(selected.has(c.id))}>
                  <span className={dot(selected.has(c.id))}>{selected.has(c.id) ? '✓' : ''}</span>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={label}>Terms</label>
            <select value={termId} onChange={(e) => setTermId(e.target.value)} className={inputCls}>
              <option value="">Customer default</option>
              {(rates?.terms || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {/* One shared pickup → destination when any fuel (lane-priced) product is selected. */}
          {anyLane && (
            <>
              <div>
                <label className={label}>Pickup</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {origins.map((o) => (
                    <button key={o} type="button" onClick={() => { setOrigin(o); setDestination(''); }} className={box(origin === o)}>
                      <span className={dot(origin === o)}>{origin === o ? '✓' : ''}</span>
                      {o}
                    </button>
                  ))}
                </div>
              </div>
              {origin && (
                <div>
                  <label className={label}>Destination</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {destinations.map((d) => (
                      <button key={d} type="button" onClick={() => setDestination(d)} className={box(destination === d)}>
                        <span className={dot(destination === d)}>{destination === d ? '✓' : ''}</span>
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* One amount input per selected product, then a single BOL. */}
          {selectedCommodities.length > 0 && (
            <div className="space-y-3">
              {selectedCommodities.map((c) => (
                <div key={c.id}>
                  <label className={label}>{c.name} — {unitLabel(c.mode)}</label>
                  <input inputMode="decimal" value={vals[c.id] || ''} placeholder={c.mode === 'amount' ? '0.00' : '0'}
                    onChange={(e) => setVals((p) => ({ ...p, [c.id]: e.target.value }))} className={inputCls} />
                  {c.mode === 'quantity' && c.unitPrice != null && <p className="text-xs text-gray-400 mt-1">{money.format(c.unitPrice)} each</p>}
                </div>
              ))}
              <div>
                <label className={label}>BOL #</label>
                <input value={bol} onChange={(e) => setBol(e.target.value)} placeholder="Bill of lading #" className={inputCls} />
              </div>

              {/* BOL document — upload a PDF, pick a photo, or take a picture. */}
              <div>
                <label className={label}>BOL document</label>
                {bolPath ? (
                  <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2">
                    <button type="button" onClick={() => viewBol(bolPath)} className="text-sm text-brand-700 underline truncate">{bolName || 'View BOL'}</button>
                    <button type="button" onClick={() => { setBolPath(''); setBolName(''); }} className="ml-auto text-xs text-gray-400 hover:text-red-600">remove</button>
                  </div>
                ) : (
                  <label className={`${inputCls} flex items-center justify-center gap-2 cursor-pointer text-gray-500 ${bolUploading ? 'opacity-50' : 'hover:bg-gray-50'}`}>
                    <span>📎 {bolUploading ? 'Uploading…' : 'Attach PDF or photo / take a picture'}</span>
                    <input type="file" accept="application/pdf,image/*" className="hidden" disabled={bolUploading}
                      onChange={(e) => onBolFile(e.target.files?.[0] || null)} />
                  </label>
                )}
              </div>
            </div>
          )}

          {freight > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
              {selectedCommodities.map((c) => freightFor(c) > 0 ? (
                <div key={c.id} className="flex justify-between"><span className="text-gray-500">{c.name}</span><span className="font-medium">{money.format(freightFor(c))}</span></div>
              ) : null)}
              {surcharge > 0 && (
                <div className="flex justify-between"><span className="text-gray-500">Fuel surcharge {pct}%</span><span className="font-medium">{money.format(surcharge)}</span></div>
              )}
              <div className="flex justify-between border-t border-gray-200 pt-1 mt-1 text-base"><span className="font-semibold">Total</span><span className="font-bold text-brand-700">{money.format(total)}</span></div>
            </div>
          )}

          <button onClick={submit} disabled={submitting || !canSubmit || (rates ? !rates.setupComplete : false)}
            className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white text-base font-semibold px-4 py-3 disabled:opacity-50">
            {submitting ? 'Creating invoice…' : 'Create invoice'}
          </button>
        </div>
      )}

      {!loading && tab === 'out' && (
        <div className="space-y-2">
          {enroute.length === 0 && <p className="text-sm text-gray-400">Nothing out for delivery.</p>}
          {enroute.map((o) => <OrderRow key={o.id} o={o} />)}
        </div>
      )}

      {!loading && tab === 'delivered' && (
        <div className="space-y-2">
          {delivered.length === 0 && <p className="text-sm text-gray-400">Nothing delivered yet.</p>}
          {delivered.map((o) => <OrderRow key={o.id} o={o} />)}
        </div>
      )}
    </div>
  );
}
