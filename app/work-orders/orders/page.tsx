'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import {
  ORDER_STATUS_LABEL, ORDER_STATUS_TONE, orderSpan,
  type JobOrder, type OrderStatus,
} from '@/lib/job-orders';

// The order book. An order is a specific job — one day or three months — and
// every ticket and every hauler dispatch points at one.

type Row = JobOrder & { tickets: number; flagged: number; customer: string | null };

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

  const refresh = useCallback(async () => {
    const [{ data: orders }, { data: tickets }, { data: biz }] = await Promise.all([
      supabase.from('job_orders').select('*').order('order_number', { ascending: false }),
      supabase.from('work_orders').select('order_id, order_mismatch, mismatch_cleared_at'),
      supabase.from('businesses').select('id, name'),
    ]);

    const names = new Map(((biz as { id: string; name: string }[]) || []).map((b) => [b.id, b.name]));
    const counts = new Map<string, { tickets: number; flagged: number }>();
    for (const t of ((tickets as { order_id: string | null; order_mismatch: string | null; mismatch_cleared_at: string | null }[]) || [])) {
      if (!t.order_id) continue;
      const c = counts.get(t.order_id) || { tickets: 0, flagged: 0 };
      c.tickets += 1;
      // A cleared flag is one the office has already looked at, so it stops
      // counting as something needing attention.
      if (t.order_mismatch && !t.mismatch_cleared_at) c.flagged += 1;
      counts.set(t.order_id, c);
    }

    setRows(((orders as JobOrder[]) || []).map((o) => ({
      ...o,
      tickets: counts.get(o.id)?.tickets || 0,
      flagged: counts.get(o.id)?.flagged || 0,
      customer: o.business_id ? (names.get(o.business_id) || null) : null,
    })));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
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
            <Link
              key={o.id}
              href={`/work-orders/orders/${o.id}`}
              className="block bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-brand-300"
            >
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <div className="min-w-0">
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
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {o.tickets > 0 && (
                    <span className="text-xs text-gray-600">
                      {o.tickets} {o.tickets === 1 ? 'ticket' : 'tickets'}
                    </span>
                  )}
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${ORDER_STATUS_TONE[o.status]}`}>
                    {ORDER_STATUS_LABEL[o.status]}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
