'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type DispatchOrder = {
  id: string;
  status: 'warehouse' | 'out_for_delivery' | 'delivered';
  delivered_at: string | null;
  loaded_at: string | null;
};
type OrderRow = {
  id: string;
  status: string;
  invoice_number: string | null;
  delivery_address: string | null;
  notes: string | null;
  sales_rep_id: string | null;
  created_at: string;
  invoiced_at: string | null;
  dispatched_at: string | null;
  dispatched_order_id: string | null;
  customer_order_items: Array<{
    id: string;
    product_name: string;
    container_size: string;
    brand: string | null;
    weight: string | null;
    quantity: number;
  }>;
};
type Profile = { id: string; full_name: string | null; email: string };
type InvoicePricing = {
  invoiced: boolean;
  found?: boolean;
  docNumber?: string;
  txnDate?: string | null;
  dueDate?: string | null;
  lines?: Array<{ name: string; qty: number | null; unitPrice: number | null; amount: number | null }>;
  subtotal?: number;
  tax?: number;
  total?: number;
  balance?: number;
};
const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Tracker step labels — what the customer sees on /shop/order/[id].
// We collapse the internal "warehouse" stage into "In progress" since
// the customer doesn't care which side of the loading dock it's on.
function trackerStep(o: OrderRow, dispatch: DispatchOrder | null): {
  label: string;
  detail: string | null;
  stage: 'pending' | 'invoiced' | 'in_progress' | 'out_for_delivery' | 'delivered' | 'cancelled';
} {
  if (o.status === 'cancelled') return { label: 'Cancelled', detail: null, stage: 'cancelled' };
  if (o.status === 'pending')   return { label: 'Pending review', detail: 'An admin is reviewing your order.', stage: 'pending' };
  if (o.status === 'invoiced')  return { label: 'Invoiced', detail: 'Your invoice is being prepared in our warehouse.', stage: 'invoiced' };
  if (dispatch?.status === 'delivered' && dispatch.delivered_at) {
    return {
      label: 'Delivered',
      detail: `Delivered ${new Date(dispatch.delivered_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
      stage: 'delivered',
    };
  }
  if (dispatch?.status === 'out_for_delivery') {
    return {
      label: 'Out for delivery',
      detail: dispatch.loaded_at ? `On the truck since ${new Date(dispatch.loaded_at).toLocaleString('en-US', { timeStyle: 'short' })}.` : 'On the truck.',
      stage: 'out_for_delivery',
    };
  }
  // dispatched but not yet loaded → "in progress"
  return { label: 'In progress', detail: 'Your order is being prepared.', stage: 'in_progress' };
}

const STAGE_CHIPS = [
  { key: 'pending',          label: 'Pending' },
  { key: 'invoiced',         label: 'Invoiced' },
  { key: 'in_progress',      label: 'In progress' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered',        label: 'Delivered' },
] as const;

export default function OrderDetailsPage() {
  const params = useParams();
  const search = useSearchParams();
  const orderId = params?.id as string;
  const justPlaced = search?.get('placed') === '1';
  const supabase = createClient();
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [dispatch, setDispatch] = useState<DispatchOrder | null>(null);
  const [rep, setRep] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState<InvoicePricing | null>(null);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('customer_orders')
      .select('*, customer_order_items(*)')
      .eq('id', orderId)
      .single();
    const o = data as OrderRow;
    setOrder(o);
    if (o?.sales_rep_id) {
      const { data: r } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', o.sales_rep_id)
        .single();
      setRep(r as Profile);
    }
    if (o?.dispatched_order_id) {
      const { data: d } = await supabase
        .from('orders')
        .select('id, status, delivered_at, loaded_at')
        .eq('id', o.dispatched_order_id)
        .single();
      setDispatch(d as DispatchOrder);
    }
    setLoading(false);
  }

  // Poll every 30s so the customer sees the status update live as the
  // driver moves through warehouse → out for delivery → delivered.
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [orderId]);

  // Pricing comes from the QuickBooks invoice (line prices aren't stored on the
  // order). Fetch once the order has an invoice number — not on every poll.
  useEffect(() => {
    if (!order) return;
    if (!order.invoice_number) { setPricing({ invoiced: false }); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/shop/order-invoice?orderId=${encodeURIComponent(orderId)}`);
        const j = await res.json();
        if (!cancelled && j.ok) setPricing(j as InvoicePricing);
      } catch { /* leave prices hidden on error */ }
    })();
    return () => { cancelled = true; };
  }, [order?.invoice_number, orderId]);

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!order) return <p className="text-sm text-gray-500">Order not found.</p>;

  return (
    <div>
      {justPlaced && (
        <div className="bg-green-50 border border-green-200 text-green-900 rounded-lg p-4 mb-6">
          <h2 className="font-semibold">Order placed — thank you!</h2>
          <p className="text-sm mt-1">
            We've received your order. Someone will create an invoice in QuickBooks
            and reach out to confirm delivery.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">
          Order <span className="font-mono text-base text-gray-500">#{order.id.slice(0, 8)}</span>
        </h1>
      </div>

      {(() => {
        const tracker = trackerStep(order, dispatch);
        const reachedStages = new Set<typeof STAGE_CHIPS[number]['key']>();
        const idx = STAGE_CHIPS.findIndex((s) => s.key === tracker.stage);
        for (let i = 0; i <= idx && idx >= 0; i++) reachedStages.add(STAGE_CHIPS[i].key);

        if (tracker.stage === 'cancelled') {
          return (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
              <h2 className="font-semibold text-gray-700">Order cancelled</h2>
            </div>
          );
        }
        return (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
            <div className="mb-3">
              <div className="font-semibold">{tracker.label}</div>
              {tracker.detail && <div className="text-xs text-gray-600 mt-0.5">{tracker.detail}</div>}
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
              {STAGE_CHIPS.map((s, i) => {
                const reached = reachedStages.has(s.key);
                const isCurrent = s.key === tracker.stage;
                return (
                  <div key={s.key} className="flex items-center gap-1.5">
                    <span
                      className={[
                        'text-[10px] uppercase tracking-wide font-medium px-2 py-1 rounded-full whitespace-nowrap border',
                        isCurrent
                          ? 'bg-brand-700 text-white border-brand-700'
                          : reached
                          ? 'bg-brand-50 text-brand-700 border-brand-200'
                          : 'bg-gray-50 text-gray-400 border-gray-200',
                      ].join(' ')}
                    >
                      {s.label}
                    </span>
                    {i < STAGE_CHIPS.length - 1 && (
                      <span className={`h-px w-3 ${reached ? 'bg-brand-200' : 'bg-gray-200'}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <p className="text-sm text-gray-500 mb-6">
        Placed {new Date(order.created_at).toLocaleString('en-US', {
          dateStyle: 'medium', timeStyle: 'short',
        })}
      </p>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Items</h2>
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 mb-6">
        {order.customer_order_items.map((it) => (
          <div key={it.id} className="px-4 py-3 flex justify-between items-center">
            <div className="text-sm">
              <div className="font-medium">{it.product_name}{it.weight ? ' ' + it.weight : ''}</div>
              <div className="text-xs text-gray-500">{it.container_size}</div>
            </div>
            <div className="text-sm tabular-nums">× {it.quantity}</div>
          </div>
        ))}
      </div>

      {/* Pricing — pulled from the QuickBooks invoice once the order is invoiced. */}
      {pricing?.found && pricing.lines && pricing.lines.length > 0 && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Invoice{pricing.docNumber ? ` #${pricing.docNumber}` : ''}
          </h2>
          <div className="bg-white border border-gray-200 rounded-lg mb-6 overflow-hidden">
            <div className="divide-y divide-gray-100">
              {pricing.lines.map((l, i) => (
                <div key={i} className="px-4 py-3 flex justify-between items-center gap-3">
                  <div className="text-sm min-w-0">
                    <div className="font-medium truncate">{l.name}</div>
                    <div className="text-xs text-gray-500">
                      {l.qty != null ? `${l.qty} × ` : ''}{money(l.unitPrice)}
                    </div>
                  </div>
                  <div className="text-sm tabular-nums font-medium shrink-0">{money(l.amount)}</div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="tabular-nums">{money(pricing.subtotal)}</span></div>
              {pricing.tax != null && pricing.tax > 0 && (
                <div className="flex justify-between"><span className="text-gray-500">Tax</span><span className="tabular-nums">{money(pricing.tax)}</span></div>
              )}
              <div className="flex justify-between font-semibold text-base pt-1"><span>Total</span><span className="tabular-nums">{money(pricing.total)}</span></div>
              {pricing.balance != null && pricing.balance > 0 && (
                <div className="flex justify-between text-amber-700"><span>Balance due</span><span className="tabular-nums">{money(pricing.balance)}</span></div>
              )}
            </div>
          </div>
        </>
      )}
      {pricing?.invoiced && (
        <a
          href={`/api/shop/invoice-pdf?orderId=${encodeURIComponent(orderId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 mb-6 px-4 py-2 text-sm font-medium rounded-md border border-brand-700 text-brand-700 hover:bg-gray-50"
        >
          📄 View / download invoice{pricing.docNumber ? ` #${pricing.docNumber}` : ''} (PDF)
        </a>
      )}
      {pricing?.invoiced && pricing.found === false && (
        <p className="text-xs text-gray-400 mb-6">Invoice pricing isn&apos;t available right now — check back shortly.</p>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Details</h2>
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2 text-sm mb-6">
        <div>
          <span className="text-gray-500">Deliver to:</span>{' '}
          <span className="whitespace-pre-wrap">{order.delivery_address || '—'}</span>
        </div>
        <div>
          <span className="text-gray-500">Sales rep:</span>{' '}
          {rep ? (rep.full_name || rep.email) : <span className="text-gray-400">— none picked —</span>}
        </div>
        {order.notes && (
          <div>
            <span className="text-gray-500">Notes:</span>{' '}
            <span className="whitespace-pre-wrap">{order.notes}</span>
          </div>
        )}
        {order.invoice_number && (
          <div>
            <span className="text-gray-500">Invoice #:</span>{' '}
            <span className="font-mono">{order.invoice_number}</span>
          </div>
        )}
      </div>

      <Link href="/shop" className="text-sm text-brand-700 hover:underline">← Back to shop</Link>
    </div>
  );
}
