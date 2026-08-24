'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

type OrderStatus = 'warehouse' | 'out_for_delivery' | 'delivered';

type Order = {
  id: string;
  date: string;
  customer: string;
  type: 'Fuel' | 'PCMO' | 'DEF' | 'Shipping';
  driver_name: string | null;
  truck: string | null;
  invoice_number: string | null;
  status: OrderStatus;
  placed_by_name: string | null;
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  warehouse: 'Warehouse',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};
const STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  warehouse: 'bg-amber-100 text-amber-900',
  out_for_delivery: 'bg-blue-100 text-blue-900',
  delivered: 'bg-emerald-100 text-emerald-900',
};

type Filter = OrderStatus | 'all';

export default function DriverOrdersPage() {
  const supabase = createClient();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<Filter>('out_for_delivery');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [ordsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('*')
        .order('date', { ascending: false }),
    ]);
    setOrders((ordsRes.data as Order[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Driver picks up a warehouse order and takes it out. Mirrors the admin
  // status change: stamp loaded_at and clear any stale delivered flags.
  async function forwardToDelivery(id: string) {
    await supabase
      .from('orders')
      .update({
        status: 'out_for_delivery',
        loaded_at: new Date().toISOString(),
        delivered: false,
        delivered_at: null,
      })
      .eq('id', id);
    load();
  }

  const filtered = filter === 'all' ? orders : orders.filter((o) => o.status === filter);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Orders</h1>
      <div className="flex gap-2 mb-4 flex-wrap">
        {([
          { key: 'warehouse',        label: 'Warehouse' },
          { key: 'out_for_delivery', label: 'Out for delivery' },
          { key: 'delivered',        label: 'Delivered' },
          { key: 'all',              label: 'All' },
        ] as const).map((f) => {
          const count = orders.filter((o) => (f.key === 'all' ? true : o.status === f.key)).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                filter === f.key ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f.label}
              {count > 0 && <span className="ml-1.5 text-xs text-gray-500">({count})</span>}
            </button>
          );
        })}
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">No orders.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(o => {
            const typeColor = {
              Fuel: 'bg-amber-100 text-amber-900',
              PCMO: 'bg-blue-100 text-blue-900',
              DEF: 'bg-purple-100 text-purple-900',
              Shipping: 'bg-emerald-100 text-emerald-900',
            }[o.type];
            return (
              <div key={o.id} className="bg-white rounded-lg p-4 border border-gray-200">
                <Link href={`/driver/order/${o.id}`} className="block hover:opacity-80">
                  <div className="flex gap-2 items-center mb-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColor}`}>{o.type}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_CLASS[o.status]}`}>
                      {STATUS_LABEL[o.status]}
                    </span>
                    <span className="text-sm text-gray-500">{o.date}</span>
                  </div>
                  <div className="font-medium">{o.customer}</div>
                  <div className="text-sm text-gray-600 mt-1">
                    {o.driver_name && <span className="mr-3">Driver: {o.driver_name}</span>}
                    {o.truck && <span className="mr-3">Truck #{o.truck}</span>}
                    {o.invoice_number && <span className="mr-3">Inv #{o.invoice_number}</span>}
                    {o.placed_by_name && <span>Placed by: {o.placed_by_name}</span>}
                  </div>
                </Link>
                {o.status === 'warehouse' && (
                  <button
                    onClick={() => forwardToDelivery(o.id)}
                    className="mt-3 w-full sm:w-auto px-3 py-2 text-sm rounded-md bg-brand-600 text-white hover:bg-brand-700 font-medium"
                  >
                    Forward to out for delivery →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
