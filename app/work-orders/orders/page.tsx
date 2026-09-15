'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import FilterBar, { EMPTY_FILTER, filterActive, type ListFilter } from '@/components/FilterBar';
import {
  ORDER_STATUS_LABEL, ORDER_STATUS_TONE, orderSpan,
  type JobOrder, type OrderStatus,
} from '@/lib/job-orders';

// The order book. An order is a specific job — one day or three months — and
// every ticket and every hauler dispatch points at one.

type Row = JobOrder & {
  tickets: number; flagged: number; customer: string | null;
  // Who worked it — resolved off the order's dispatches and tickets, which is
  // what the hauler/driver filters match against.
  haulerIds: string[];
  driverNames: string[];
};

const FILTERS: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'complete', label: 'Complete' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function OrdersPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  // Open is the default: it is the work that still needs someone. Finished
  // and cancelled orders are lookups, not a to-do list.
  const [filter, setFilter] = useState<OrderStatus | 'all'>('open');
  const [bar, setBar] = useState<ListFilter>(EMPTY_FILTER);
  const [haulers, setHaulers] = useState<{ id: string; name: string }[]>([]);
  // The SEND pill: dispatch an order to a hauler right off this list —
  // pick the company and how many trucks; each truck becomes its own load.
  const [sendFor, setSendFor] = useState<string | null>(null);
  const [sendHauler, setSendHauler] = useState('');
  const [sendTrucks, setSendTrucks] = useState('1');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendNote, setSendNote] = useState<{ id: string; msg: string; ok: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const [{ data: orders }, { data: tickets }, { data: biz }, { data: dispatches }, { data: haulerRows }] = await Promise.all([
      supabase.from('job_orders').select('*').order('order_number', { ascending: false }),
      supabase.from('work_orders').select('order_id, order_mismatch, mismatch_cleared_at, hauler_id, driver_name'),
      supabase.from('businesses').select('id, name'),
      supabase.from('hauler_loads').select('order_id, hauler_id'),
      supabase.from('haulers').select('id, name').order('name'),
    ]);

    setHaulers((haulerRows as { id: string; name: string }[]) || []);
    const names = new Map(((biz as { id: string; name: string }[]) || []).map((b) => [b.id, b.name]));
    const counts = new Map<string, { tickets: number; flagged: number }>();
    const haulersByOrder = new Map<string, Set<string>>();
    const driversByOrder = new Map<string, Set<string>>();
    for (const t of ((tickets as { order_id: string | null; order_mismatch: string | null; mismatch_cleared_at: string | null; hauler_id: string | null; driver_name: string | null }[]) || [])) {
      if (!t.order_id) continue;
      const c = counts.get(t.order_id) || { tickets: 0, flagged: 0 };
      c.tickets += 1;
      // A cleared flag is one the office has already looked at, so it stops
      // counting as something needing attention.
      if (t.order_mismatch && !t.mismatch_cleared_at) c.flagged += 1;
      counts.set(t.order_id, c);
      if (t.hauler_id) (haulersByOrder.get(t.order_id) || haulersByOrder.set(t.order_id, new Set()).get(t.order_id)!).add(t.hauler_id);
      if (t.driver_name) (driversByOrder.get(t.order_id) || driversByOrder.set(t.order_id, new Set()).get(t.order_id)!).add(t.driver_name.toLowerCase());
    }
    // Dispatched-but-not-yet-ticketed loads still tie the hauler to the order.
    for (const d of ((dispatches as { order_id: string | null; hauler_id: string }[]) || [])) {
      if (!d.order_id) continue;
      (haulersByOrder.get(d.order_id) || haulersByOrder.set(d.order_id, new Set()).get(d.order_id)!).add(d.hauler_id);
    }

    setRows(((orders as JobOrder[]) || []).map((o) => ({
      ...o,
      tickets: counts.get(o.id)?.tickets || 0,
      flagged: counts.get(o.id)?.flagged || 0,
      customer: o.business_id ? (names.get(o.business_id) || null) : null,
      haulerIds: [...(haulersByOrder.get(o.id) || [])],
      driverNames: [...(driversByOrder.get(o.id) || [])],
    })));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function sendOrder(orderId: string) {
    if (!sendHauler) { setSendNote({ id: orderId, msg: 'Pick a hauler first.', ok: false }); return; }
    setSendBusy(true); setSendNote(null);
    try {
      const res = await fetch('/api/haulers/loads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hauler_id: sendHauler,
          order_ids: [orderId],
          trucks: Math.max(1, Number(sendTrucks) || 1),
        }),
      });
      const json = await res.json();
      if (!json.ok) { setSendNote({ id: orderId, msg: json.error || 'Could not send the order.', ok: false }); return; }
      const name = haulers.find((h) => h.id === sendHauler)?.name || 'the hauler';
      setSendNote({
        id: orderId,
        msg: `Sent ${json.count} ${json.count === 1 ? 'load' : 'loads'} to ${name} — they've been notified.`,
        ok: true,
      });
      setSendFor(null);
      refresh();
    } catch {
      setSendNote({ id: orderId, msg: 'Network error — try again.', ok: false });
    } finally {
      setSendBusy(false);
    }
  }

  // What "matches" means for an order: the job by number or name; the hauler
  // by who its loads/tickets went to; the driver by the names on its tickets;
  // billing by the order's own rate unit; dates by overlap with its run.
  function matchesOrder(f: ListFilter, o: Row): boolean {
    const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();
    if (f.job) {
      const q = norm(f.job);
      if (!norm(o.job_number).includes(q) && !norm(o.job_name).includes(q)) return false;
    }
    if (f.haulerId === 'own') { if (o.haulerIds.length > 0) return false; }
    else if (f.haulerId) { if (!o.haulerIds.includes(f.haulerId)) return false; }
    if (f.driver && !o.driverNames.some((d) => d.includes(norm(f.driver)))) return false;
    if (f.billing && (o.rate_unit || 'hour') !== f.billing) return false;
    // Date range: the order's run has to touch the window.
    if (f.from && o.end_date && o.end_date < f.from) return false;
    if (f.to && o.start_date && o.start_date > f.to) return false;
    if ((f.from || f.to) && !o.start_date && !o.end_date) return false;
    return true;
  }

  const byStatus = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const visible = filterActive(bar) ? byStatus.filter((r) => matchesOrder(bar, r)) : byStatus;
  const totalFlagged = rows.reduce((n, r) => n + r.flagged, 0);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <Link
          href="/work-orders/orders/new"
          className="px-3 py-2 text-sm bg-accent-400 text-white rounded-md hover:bg-accent-500 font-medium"
        >
          Create order
        </Link>
      </div>

      {totalFlagged > 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{totalFlagged}</strong> {totalFlagged === 1 ? 'ticket doesn' : 'tickets don'}&apos;t
          match their order. Open the order to see what&apos;s off.
        </div>
      )}

      <FilterBar
        value={bar} onChange={setBar} haulers={haulers}
        matched={visible.length} total={byStatus.length}
      />

      <div className="flex gap-2 mb-4 flex-wrap">
        {FILTERS.map((f) => {
          const count = f.key === 'all' ? rows.length : rows.filter((r) => r.status === f.key).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                filter === f.key
                  ? 'bg-brand-700 text-white border-brand-700 font-medium'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f.label} {count > 0 && <span className="opacity-70">({count})</span>}
            </button>
          );
        })}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500">
          {rows.length === 0
            ? 'No orders yet. Create the first one — it’s the job everything else gets tied to.'
            : filter === 'open'
              ? `No open orders. There ${rows.length === 1 ? 'is 1 order' : `are ${rows.length} orders`} under the other tabs.`
              : 'Nothing with that status.'}
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((o) => (
            <div
              key={o.id}
              className="bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-brand-300"
            >
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <Link href={`/work-orders/orders/${o.id}`} className="min-w-0 block flex-1">
                  <span className="font-medium text-sm">
                    #{o.order_number}
                    {o.job_name ? ` · ${o.job_name}` : o.job_number ? ` · Job ${o.job_number}` : ''}
                  </span>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[
                      o.customer,
                      o.job_number && o.job_name ? `Job ${o.job_number}` : null,
                      o.phase_code ? `Phase ${o.phase_code}` : null,
                      orderSpan(o),
                      o.rate != null ? `$${Number(o.rate).toFixed(2)}/${o.rate_unit || 'hr'}` : null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                  {o.flagged > 0 && (
                    <div className="text-xs text-red-600 font-medium mt-0.5">
                      {o.flagged} {o.flagged === 1 ? 'ticket doesn' : 'tickets don'}&apos;t match
                    </div>
                  )}
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  {o.tickets > 0 && (
                    <span className="text-xs text-gray-600">
                      {o.tickets} {o.tickets === 1 ? 'ticket' : 'tickets'}
                    </span>
                  )}
                  {/* Only work that's still live gets offered out. */}
                  {['open', 'active'].includes(o.status) && (
                    <button
                      onClick={() => {
                        setSendNote(null);
                        setSendFor(sendFor === o.id ? null : o.id);
                        setSendHauler(''); setSendTrucks('1');
                      }}
                      className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
                        sendFor === o.id
                          ? 'bg-brand-700 text-white border-brand-700'
                          : 'bg-accent-400 text-white border-accent-400 hover:bg-accent-500'
                      }`}
                    >
                      {sendFor === o.id ? 'Cancel' : 'Send'}
                    </button>
                  )}
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${ORDER_STATUS_TONE[o.status]}`}>
                    {ORDER_STATUS_LABEL[o.status]}
                  </span>
                </div>
              </div>

              {sendFor === o.id && (
                <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 flex items-end gap-3 flex-wrap">
                  <label className="text-xs text-gray-600">Hauler
                    <select
                      value={sendHauler}
                      onChange={(e) => setSendHauler(e.target.value)}
                      className="block mt-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white min-w-[180px]"
                    >
                      <option value="">— Pick a hauler —</option>
                      {haulers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-gray-600">Trucks
                    <input
                      type="number" min="1" max="20" inputMode="numeric"
                      value={sendTrucks}
                      onChange={(e) => setSendTrucks(e.target.value)}
                      className="block mt-1 w-20 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
                    />
                  </label>
                  <button
                    onClick={() => sendOrder(o.id)}
                    disabled={sendBusy || !sendHauler}
                    className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
                  >
                    {sendBusy ? 'Sending…' : `Send ${Math.max(1, Number(sendTrucks) || 1)} ${(Number(sendTrucks) || 1) === 1 ? 'load' : 'loads'}`}
                  </button>
                  <span className="text-[11px] text-gray-500 basis-full">
                    Each truck is its own load — the hauler accepts them and puts a driver on each.
                    They&apos;re offered the pay rate{o.pay_rate != null ? ` ($${Number(o.pay_rate).toFixed(2)}/${o.rate_unit || 'hour'})` : ' — none set on this order yet'}.
                  </span>
                </div>
              )}
              {sendNote?.id === o.id && (
                <p className={`mt-2 text-sm ${sendNote.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                  {sendNote.msg}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
