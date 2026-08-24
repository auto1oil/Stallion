'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type DispatchStatus = 'warehouse' | 'out_for_delivery' | 'delivered';
type Tab = 'pending' | DispatchStatus;

type Order = {
  id: string;
  date: string;
  customer: string;
  type: 'Fuel' | 'PCMO' | 'DEF' | 'Shipping';
  driver_name: string | null;
  truck: string | null;
  invoice_number: string | null;
  status: DispatchStatus;
  placed_by_name: string | null;
};

type Pending = {
  id: string;
  invoice_number: string | null;
  created_at: string | null;
  invoiced_at: string | null;
  customer: { full_name: string | null; email: string; business_name: string | null } | null;
  submitted_by: { full_name: string | null; email: string } | null;
};

const STATUS_LABEL: Record<DispatchStatus, string> = {
  warehouse: 'Warehouse',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};
const STATUS_BADGE_CLASS: Record<DispatchStatus, string> = {
  warehouse: 'bg-amber-100 text-amber-900',
  out_for_delivery: 'bg-blue-100 text-blue-900',
  delivered: 'bg-emerald-100 text-emerald-900',
};
const TYPE_BADGE_CLASS: Record<Order['type'], string> = {
  Fuel: 'bg-amber-100 text-amber-900',
  PCMO: 'bg-blue-100 text-blue-900',
  DEF: 'bg-purple-100 text-purple-900',
  Shipping: 'bg-emerald-100 text-emerald-900',
};

// Read-only order board for non-admin staff. Mirrors the admin board's four
// stages — Pending → Warehouse → Out for delivery → Delivered — but shows
// only the order and invoice number: no documents, no edit/status controls.
export default function OrderStatusBoard() {
  const supabase = createClient();
  const [orders, setOrders] = useState<Order[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [tab, setTab] = useState<Tab>('warehouse');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [ordsRes, pendRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id, date, customer, type, driver_name, truck, invoice_number, status, placed_by_name')
          .order('date', { ascending: false }),
        supabase
          .from('customer_orders')
          .select(`
            id, invoice_number, created_at, invoiced_at,
            customer:profiles!customer_orders_customer_id_fkey(full_name, email, business_name),
            submitted_by:profiles!customer_orders_submitted_by_id_fkey(full_name, email)
          `)
          .in('status', ['pending', 'invoiced'])
          .is('dispatched_order_id', null)
          .order('created_at', { ascending: false }),
      ]);
      setOrders((ordsRes.data as Order[]) || []);
      setPending((pendRes.data as unknown as Pending[]) || []);
      setLoading(false);
    })();
  }, []);

  const dispatchFiltered = orders.filter((o) => o.status === tab);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'pending', label: 'Pending', count: pending.length },
    { key: 'warehouse', label: 'Warehouse', count: orders.filter((o) => o.status === 'warehouse').length },
    { key: 'out_for_delivery', label: 'Out for delivery', count: orders.filter((o) => o.status === 'out_for_delivery').length },
    { key: 'delivered', label: 'Delivered', count: orders.filter((o) => o.status === 'delivered').length },
  ];

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              tab === t.key
                ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                : 'bg-white border-gray-300 hover:bg-gray-50'
            }`}
          >
            {t.label}
            {t.count > 0 && <span className="ml-1.5 text-xs text-gray-500">({t.count})</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : tab === 'pending' ? (
        pending.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-12">No orders awaiting approval.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => <PendingCard key={p.id} order={p} />)}
          </div>
        )
      ) : dispatchFiltered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">No orders here.</p>
      ) : (
        <div className="space-y-2">
          {dispatchFiltered.map((o) => <OrderRow key={o.id} order={o} />)}
        </div>
      )}
    </div>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE_CLASS[order.type]}`}>{order.type}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_CLASS[order.status]}`}>
          {STATUS_LABEL[order.status]}
        </span>
        <span className="text-sm text-gray-500">{order.date}</span>
      </div>
      <div className="font-medium mb-1">{order.customer}</div>
      <div className="text-sm text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
        {order.driver_name && <span>Driver: {order.driver_name}</span>}
        {order.truck && <span>Truck #{order.truck}</span>}
        {order.invoice_number ? (
          <span>Invoice #{order.invoice_number}</span>
        ) : (
          <span className="italic text-gray-400">No invoice #</span>
        )}
        {order.placed_by_name && <span>Placed by: {order.placed_by_name}</span>}
      </div>
      {order.status !== 'delivered' && (
        <Link href={`/salesman/deliver/${order.id}`}
          className="mt-3 inline-block px-3 py-1.5 text-xs rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900">
          ✍ Sign / mark delivered
        </Link>
      )}
    </div>
  );
}

function PendingCard({ order }: { order: Pending }) {
  const customerName =
    order.customer?.business_name || order.customer?.full_name || order.customer?.email || 'Customer';
  const placedByName = order.submitted_by?.full_name || order.submitted_by?.email || null;
  const date = (order.invoiced_at || order.created_at || '').slice(0, 10);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-700">Pending</span>
        {date && <span className="text-sm text-gray-500">{date}</span>}
      </div>
      <div className="font-medium mb-1">{customerName}</div>
      <div className="text-sm text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
        {order.invoice_number ? (
          <span>Invoice #{order.invoice_number}</span>
        ) : (
          <span className="italic text-gray-400">Not yet invoiced</span>
        )}
        {placedByName && <span>Placed by: {placedByName}</span>}
      </div>
    </div>
  );
}
