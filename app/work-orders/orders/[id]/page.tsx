'use client';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import OrderForm from '@/components/OrderForm';
import {
  ORDER_STATUS_LABEL, ORDER_STATUS_TONE, orderSpan, type JobOrder,
} from '@/lib/job-orders';
import {
  STATUS_LABEL, STATUS_TONE, ticketAmount, totalHours,
  type WorkOrder, type WorkOrderStatus,
} from '@/lib/work-orders';
import {
  LOAD_STATUS_LABEL, LOAD_STATUS_TONE, type HaulerLoad, type LoadStatus,
} from '@/lib/haulers';

// One order: the agreed terms, every ticket filed against it, and anything on
// those tickets that disagrees with what was agreed.

// The address opens the Maps app. maps.apple.com opens Apple Maps on Apple
// devices and falls through to Google Maps elsewhere, so one link serves
// every phone in the field.
function MapLink({ address }: { address: string }) {
  return (
    <a
      href={`https://maps.apple.com/?q=${encodeURIComponent(address)}`}
      target="_blank"
      rel="noreferrer"
      className="text-brand-700 hover:underline"
    >
      {address} <span aria-hidden>↗</span>
    </a>
  );
}

// "07:00:00" from a time column → "7:00 AM".
function clock(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return t;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// rate_unit → the suffix after the dollar figure.
const PER: Record<string, string> = { hour: 'hr', ton: 'ton', load: 'load', day: 'day' };
const BILLING: Record<string, string> = {
  hour: 'Hourly', ton: 'By the ton', load: 'By the load', day: 'By the day',
};

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const [order, setOrder] = useState<JobOrder | null>(null);
  const [tickets, setTickets] = useState<WorkOrder[]>([]);
  const [loads, setLoads] = useState<(HaulerLoad & { hauler_name?: string; driver_name?: string })[]>([]);
  const [customer, setCustomer] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    const { data: o } = await supabase
      .from('job_orders').select('*').eq('id', params.id).maybeSingle();
    if (!o) { setError('That order no longer exists.'); return; }
    setOrder(o as JobOrder);

    const [{ data: t }, { data: biz }, { data: l }, { data: h }] = await Promise.all([
      supabase.from('work_orders').select('*').eq('order_id', params.id)
        .order('job_date', { ascending: false, nullsFirst: false }),
      (o as JobOrder).business_id
        ? supabase.from('businesses').select('name').eq('id', (o as JobOrder).business_id!).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('hauler_loads').select('*').eq('order_id', params.id)
        .order('created_at', { ascending: false }),
      supabase.from('haulers').select('id, name'),
    ]);
    setTickets((t as WorkOrder[]) || []);
    setCustomer((biz as { name: string } | null)?.name ?? null);
    const names = new Map(((h as { id: string; name: string }[]) || []).map((x) => [x.id, x.name]));

    // Driver names live on profiles; dispatches only carry the id.
    const loadRows = (l as HaulerLoad[]) || [];
    const driverIds = Array.from(new Set(loadRows.map((x) => x.driver_id).filter(Boolean))) as string[];
    let drivers = new Map<string, string>();
    if (driverIds.length) {
      const { data: ppl } = await supabase.from('profiles').select('id, full_name').in('id', driverIds);
      drivers = new Map(((ppl as { id: string; full_name: string | null }[]) || [])
        .map((p) => [p.id, p.full_name || '']));
    }
    setLoads(loadRows.map((ld) => ({
      ...ld,
      hauler_name: names.get(ld.hauler_id),
      driver_name: (ld.driver_id && drivers.get(ld.driver_id)) || undefined,
    })));
  }, [supabase, params.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // Clearing a flag is the office saying "I looked, it's fine" — so it records
  // who and when rather than just wiping the note.
  async function clearFlag(t: WorkOrder) {
    setBusy(t.id); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('work_orders').update({
      mismatch_cleared_by: user?.id ?? null,
      mismatch_cleared_at: new Date().toISOString(),
    }).eq('id', t.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  const card = 'bg-white border border-gray-200 rounded-lg p-4';

  if (error && !order) return <p className="text-sm text-red-600">{error}</p>;
  if (!order) return <p className="text-sm text-gray-500">Loading…</p>;

  if (editing) {
    return (
      <div>
        <button onClick={() => setEditing(false)} className="text-sm text-brand-700 hover:underline">
          ← Back to the order
        </button>
        <h1 className="text-2xl font-semibold mt-2 mb-4">Edit order #{order.order_number}</h1>
        <OrderForm order={order} />
      </div>
    );
  }

  const flagged = tickets.filter((t) => t.order_mismatch && !t.mismatch_cleared_at);
  const billed = tickets.reduce((n, t) => n + ticketAmount(t), 0);
  const hours = tickets.reduce((n, t) => n + totalHours(t), 0);
  const tons = tickets.reduce((n, t) => n + Number(t.loads_tons || 0), 0);

  const per = PER[order.rate_unit || 'hour'] || 'hr';
  const money = (v: number | null) => (v == null ? null : `$${Number(v).toFixed(2)}`);
  const hrs = (v: number | null) => (v == null ? null : `${Number(v).toFixed(2)} hrs`);
  const margin = order.rate != null && order.pay_rate != null
    ? Number(order.rate) - Number(order.pay_rate) : null;

  // Every agreed term is listed, filled or not — a review needs to see what's
  // missing as much as what's there, so an empty one shows a dash instead of
  // disappearing.
  const facts: [string, ReactNode][] = [
    ['Customer', customer],
    ['Customer #', order.customer_number],
    ['Job #', order.job_number],
    ['Phase', order.phase_code],
    ['FSR', order.fsr],
    ['Address', order.job_address ? <MapLink address={order.job_address} /> : null],
    ['Load at', order.load_address ? <MapLink address={order.load_address} /> : null],
    ['Unload at', order.unload_address ? <MapLink address={order.unload_address} /> : null],
    ['Runs', orderSpan(order)],
    ['Daily start', clock(order.start_time)],
    ['Daily stop', clock(order.stop_time)],
    ['Billing', order.rate_unit ? BILLING[order.rate_unit] || order.rate_unit : null],
    ['Customer rate', order.rate != null ? `${money(Number(order.rate))}/${per}` : null],
    ['Hauler pay rate', order.pay_rate != null ? `${money(Number(order.pay_rate))}/${per}` : null],
    ['Margin', margin == null ? null : (
      <span className={margin < 0 ? 'text-red-700 font-medium' : undefined}>
        {money(margin)}/{per}
      </span>
    )],
    ['Fuel surcharge', money(order.fuel_surcharge == null ? null : Number(order.fuel_surcharge))],
    ['Travel', hrs(order.travel_hours == null ? null : Number(order.travel_hours))],
    ['Down time', hrs(order.down_hours == null ? null : Number(order.down_hours))],
    ['Tonnage', order.tonnage != null ? `${Number(order.tonnage).toFixed(2)} ${order.tonnage_type || ''}`.trim() : null],
    ['Equipment', order.equipment_type],
    ['Unit #', order.unit_number],
  ];

  return (
    <div className="space-y-4">
      <Link href="/work-orders/orders" className="text-sm text-brand-700 hover:underline">← Orders</Link>

      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">
          #{order.order_number}
          {order.job_name ? ` · ${order.job_name}` : ''}
        </h1>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${ORDER_STATUS_TONE[order.status]}`}>
            {ORDER_STATUS_LABEL[order.status]}
          </span>
          <button onClick={() => setEditing(true)} className="text-sm text-brand-700 hover:underline">Edit</button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {flagged.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>{flagged.length}</strong> {flagged.length === 1 ? 'ticket doesn' : 'tickets don'}&apos;t
          match this order. They&apos;re marked below — check each one before it&apos;s billed.
        </div>
      )}

      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Agreed</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-gray-500">{k}</dt>
              <dd>{v || <span className="text-gray-400">—</span>}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="text-xs text-gray-500 mb-1">Job notes</div>
          {order.notes
            ? <p className="text-sm text-gray-700 whitespace-pre-wrap">{order.notes}</p>
            : <p className="text-sm text-gray-400">No notes on this order.</p>}
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
          Sent to haulers
        </h2>
        {loads.length === 0 ? (
          <p className="text-sm text-gray-500">
            This order hasn&apos;t been sent to any hauler. Send it from the
            orders list or from a hauler&apos;s page.
          </p>
        ) : (
          <div className="space-y-2">
            {loads.map((ld) => (
              <div
                key={ld.id}
                className="border border-gray-200 rounded-md px-3 py-2 flex justify-between items-start gap-3 flex-wrap"
              >
                <div className="min-w-0">
                  <Link href={`/haulers/${ld.hauler_id}`} className="font-medium text-sm hover:text-brand-700">
                    {ld.hauler_name || 'Hauler'}
                  </Link>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[
                      ld.job_date,
                      ld.driver_name ? `Driver: ${ld.driver_name}` : null,
                      ld.equipment_type,
                      ld.pickup && ld.dropoff ? `${ld.pickup} → ${ld.dropoff}` : (ld.pickup || ld.dropoff),
                      ld.rate != null
                        ? `$${Number(ld.rate).toFixed(2)}/${PER[ld.rate_unit || 'hour'] || 'hr'}`
                        : null,
                    ].filter(Boolean).join(' · ') || 'No details on this dispatch'}
                  </div>
                  {ld.status === 'declined' && ld.decline_reason && (
                    <div className="text-xs text-red-700 mt-0.5">Declined: {ld.decline_reason}</div>
                  )}
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${LOAD_STATUS_TONE[ld.status as LoadStatus]}`}>
                  {LOAD_STATUS_LABEL[ld.status as LoadStatus]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={card}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Tickets on this order
          </h2>
          {tickets.length > 0 && (
            <span className="text-sm text-gray-600">
              {hours.toFixed(2)} hrs · {tons.toFixed(2)} tons ·{' '}
              <strong>${billed.toFixed(2)}</strong>
            </span>
          )}
        </div>

        {tickets.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing filed against this order yet. A crew picks it on the ticket
            form, or it fills in when a hauler accepts a load for it.
          </p>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => {
              const isFlagged = t.order_mismatch && !t.mismatch_cleared_at;
              return (
                <div
                  key={t.id}
                  className={`border rounded-md px-3 py-2 ${isFlagged ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
                >
                  <div className="flex justify-between items-start gap-3 flex-wrap">
                    <div className="min-w-0">
                      <Link href={`/work-orders/${t.id}`} className="font-medium text-sm hover:text-brand-700">
                        {t.job_date || 'Ticket'}
                        {t.unit_number ? ` · Unit ${t.unit_number}` : ''}
                        {t.driver_name ? ` · ${t.driver_name}` : ''}
                      </Link>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {[
                          `${totalHours(t).toFixed(2)} hrs`,
                          t.loads_count > 0 ? `${t.loads_count} loads · ${Number(t.loads_tons).toFixed(2)} tons` : null,
                          `$${ticketAmount(t).toFixed(2)}`,
                        ].filter(Boolean).join(' · ')}
                      </div>
                      {t.order_mismatch && (
                        <div className={`text-xs mt-1 ${t.mismatch_cleared_at ? 'text-gray-500' : 'text-red-700 font-medium'}`}>
                          {t.mismatch_cleared_at ? 'Checked and allowed: ' : "Doesn't match: "}
                          {t.order_mismatch}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_TONE[t.status as WorkOrderStatus]}`}>
                        {STATUS_LABEL[t.status as WorkOrderStatus]}
                      </span>
                    </div>
                  </div>
                  {isFlagged && (
                    <button
                      onClick={() => clearFlag(t)}
                      disabled={busy === t.id}
                      className="mt-2 px-2.5 py-1 text-xs rounded-md border border-red-300 bg-white hover:bg-red-100 disabled:opacity-50"
                    >
                      {busy === t.id ? 'Saving…' : 'I checked it — allow'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
