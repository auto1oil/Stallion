'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

// Fuel purchase orders — auto-created when a fuel order is placed (rack + fuel
// account + gallons, price blank). The buyer fills in the per-gallon price when
// the supplier's bill arrives, then checks the PO off as "bill received &
// correct". A line with no price yet is outlined in RED = needs attention.

type Line = {
  id: string;
  product_name: string;
  container_size: string | null;
  gallons: number;
  unit_price: number | null;
};

type FuelPO = {
  id: string;
  po_number: number;
  order_id: string | null;
  order_ref: string | null;
  rack: string;
  fuel_account: string;
  status: 'open' | 'confirmed' | 'canceled';
  bill_received: boolean;
  confirmed_at: string | null;
  canceled_at: string | null;
  created_by_name: string | null;
  created_at: string;
  fuel_po_lines: Line[];
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 4 });
const gal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export default function AdminFuelPoPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<FuelPO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  // Per-line price drafts (string, keyed by line id) while editing.
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // po id currently saving

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('fuel_purchase_orders')
      .select('id, po_number, order_id, order_ref, rack, fuel_account, status, bill_received, confirmed_at, canceled_at, created_by_name, created_at, fuel_po_lines(id, product_name, container_size, gallons, unit_price)')
      .order('po_number', { ascending: false });
    if (error) {
      // 42P01 = undefined_table: the fuel-PO tables haven't been created yet.
      if ((error as { code?: string }).code === '42P01') setNeedsSetup(true);
      else setLoadError(error.message);
      setRows([]);
    } else {
      setLoadError('');
      setNeedsSetup(false);
      setRows((data as unknown as FuelPO[]) || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setMeId(user?.id || null);
      await load();
    })();
  }, [supabase, load]);

  // Effective price string for a line: the draft if edited, else the saved value.
  function effPrice(line: Line): string {
    if (line.id in priceDraft) return priceDraft[line.id];
    return line.unit_price != null ? String(line.unit_price) : '';
  }
  function priceNum(line: Line): number | null {
    const s = effPrice(line).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function allPriced(po: FuelPO): boolean {
    return po.fuel_po_lines.length > 0 && po.fuel_po_lines.every((l) => priceNum(l) != null);
  }

  function setPrice(lineId: string, val: string) {
    setPriceDraft((d) => ({ ...d, [lineId]: val }));
  }

  // Persist any edited prices for a PO's lines. Returns true on success.
  async function savePrices(po: FuelPO): Promise<boolean> {
    for (const line of po.fuel_po_lines) {
      if (!(line.id in priceDraft)) continue;
      const n = priceNum(line);
      const { error } = await supabase
        .from('fuel_po_lines')
        .update({ unit_price: n })
        .eq('id', line.id);
      if (error) { setLoadError(error.message); return false; }
    }
    return true;
  }

  async function saveOnly(po: FuelPO) {
    setBusy(po.id);
    const ok = await savePrices(po);
    if (ok) {
      // Drop the drafts we just saved so the row reflects stored values.
      setPriceDraft((d) => {
        const next = { ...d };
        for (const l of po.fuel_po_lines) delete next[l.id];
        return next;
      });
      await load();
    }
    setBusy(null);
  }

  async function confirmPo(po: FuelPO) {
    if (!allPriced(po)) return;
    setBusy(po.id);
    const ok = await savePrices(po);
    if (ok) {
      const { error } = await supabase
        .from('fuel_purchase_orders')
        .update({ status: 'confirmed', bill_received: true, confirmed_at: new Date().toISOString(), confirmed_by: meId })
        .eq('id', po.id);
      if (error) setLoadError(error.message);
      else {
        setPriceDraft((d) => {
          const next = { ...d };
          for (const l of po.fuel_po_lines) delete next[l.id];
          return next;
        });
        await load();
      }
    }
    setBusy(null);
  }

  async function reopenPo(po: FuelPO) {
    setBusy(po.id);
    const { error } = await supabase
      .from('fuel_purchase_orders')
      .update({ status: 'open', bill_received: false, confirmed_at: null, confirmed_by: null })
      .eq('id', po.id);
    if (error) setLoadError(error.message);
    else await load();
    setBusy(null);
  }

  async function cancelPo(po: FuelPO) {
    if (!confirm(`Cancel Fuel PO #${po.po_number}? It stays on record, just marked canceled.`)) return;
    setBusy(po.id);
    const { error } = await supabase
      .from('fuel_purchase_orders')
      .update({ status: 'canceled', canceled_at: new Date().toISOString() })
      .eq('id', po.id);
    if (error) setLoadError(error.message);
    else await load();
    setBusy(null);
  }

  async function restorePo(po: FuelPO) {
    setBusy(po.id);
    const { error } = await supabase
      .from('fuel_purchase_orders')
      .update({ status: 'open', canceled_at: null })
      .eq('id', po.id);
    if (error) setLoadError(error.message);
    else await load();
    setBusy(null);
  }

  const open = rows.filter((r) => r.status === 'open');
  const done = rows.filter((r) => r.status !== 'open');

  function poTotal(po: FuelPO): number {
    return po.fuel_po_lines.reduce((sum, l) => {
      const n = priceNum(l);
      return sum + (n != null ? n * Number(l.gallons) : 0);
    }, 0);
  }

  function Card({ po }: { po: FuelPO }) {
    const canceled = po.status === 'canceled';
    const confirmed = po.status === 'confirmed';
    return (
      <div className={`rounded-lg border bg-white p-4 ${canceled ? 'opacity-60 border-gray-200' : confirmed ? 'border-green-300' : 'border-gray-200'}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900">Fuel PO #{po.po_number}</span>
              {confirmed && <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-800">✓ Bill received &amp; correct</span>}
              {canceled && <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">Canceled</span>}
              {po.status === 'open' && <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Awaiting bill</span>}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {fmtDateTime(po.created_at)} · Rack: <span className="font-medium text-gray-700">{po.rack}</span> · Account: <span className="font-medium text-gray-700">{po.fuel_account}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {po.order_id ? (
                <Link href={`/admin/customer-orders/${po.order_id}`} className="text-brand-700 hover:underline">Order #{po.order_ref}</Link>
              ) : (
                <span>Order #{po.order_ref || '—'}</span>
              )}
              {po.created_by_name ? ` · by ${po.created_by_name}` : ''}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold text-gray-900">{money.format(poTotal(po))}</div>
            <div className="text-[10px] text-gray-400">est. total</div>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {po.fuel_po_lines.map((line) => {
            const n = priceNum(line);
            const needsPrice = n == null;
            const editable = !canceled && !confirmed;
            return (
              <div
                key={line.id}
                className={`flex items-center gap-3 rounded-md border px-3 py-2 ${needsPrice ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 truncate">{line.product_name}</div>
                  <div className="text-xs text-gray-500">{gal.format(Number(line.gallons))} gal{line.container_size ? ` · ${line.container_size}` : ''}</div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-gray-400 text-sm">$</span>
                  <input
                    type="number"
                    step="0.0001"
                    inputMode="decimal"
                    disabled={!editable || busy === po.id}
                    value={effPrice(line)}
                    onChange={(e) => setPrice(line.id, e.target.value)}
                    placeholder="/gal"
                    className={`w-24 px-2 py-1 border rounded text-right text-sm ${needsPrice ? 'border-red-400' : 'border-gray-300'} disabled:bg-gray-50 disabled:text-gray-500`}
                  />
                  <span className="text-gray-400 text-xs">/gal</span>
                </div>
                <div className="w-20 text-right text-sm text-gray-700">
                  {n != null ? money.format(n * Number(line.gallons)) : <span className="text-red-500 text-xs">needs price</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          {po.status === 'open' && (
            <>
              <button onClick={() => cancelPo(po)} disabled={busy === po.id} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              <button onClick={() => saveOnly(po)} disabled={busy === po.id} className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                Save prices
              </button>
              <button
                onClick={() => confirmPo(po)}
                disabled={busy === po.id || !allPriced(po)}
                title={allPriced(po) ? '' : 'Enter every line price first'}
                className="text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ✓ Bill received &amp; correct
              </button>
            </>
          )}
          {confirmed && (
            <button onClick={() => reopenPo(po)} disabled={busy === po.id} className="text-xs text-brand-700 hover:underline">Reopen</button>
          )}
          {canceled && (
            <button onClick={() => restorePo(po)} disabled={busy === po.id} className="text-xs text-brand-700 hover:underline">Restore</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Fuel POs</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Auto-created when a fuel order is placed. Fill in the per-gallon price when the supplier&apos;s bill arrives,
        then check it off. <span className="text-red-500">Red</span> lines still need a price.
      </p>

      {needsSetup && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 mb-4">
          The fuel-PO tables aren&apos;t created yet. Run the <code>fuel_purchase_orders</code> / <code>fuel_po_lines</code>{' '}
          section of <code>supabase-setup.sql</code> in the Supabase SQL editor, then reload.
        </div>
      )}
      {loadError && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 mb-4">{loadError}</div>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <>
          {open.length === 0 && !needsSetup && (
            <p className="text-sm text-gray-400 mb-6">No open fuel POs. New ones appear here automatically when a fuel order is placed.</p>
          )}
          <div className="space-y-3">
            {open.map((po) => <Card key={po.id} po={po} />)}
          </div>

          {done.length > 0 && (
            <div className="mt-8">
              <button onClick={() => setShowDone((s) => !s)} className="text-sm text-gray-500 hover:text-gray-700 mb-3">
                {showDone ? '▾' : '▸'} Confirmed &amp; canceled ({done.length})
              </button>
              {showDone && (
                <div className="space-y-3">
                  {done.map((po) => <Card key={po.id} po={po} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
