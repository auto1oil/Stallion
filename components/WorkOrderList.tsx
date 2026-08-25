'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  STATUS_LABEL, STATUS_TONE, totalHours, ticketAmount, billableUnit, billableQuantity,
  type WorkOrder, type WorkOrderStatus,
} from '@/lib/work-orders';

// The shared ticket list. Every role sees the same cards; what differs is which
// tickets the API hands back (RLS), where a card links to, and whether the
// per-row action button is shown.

export type ListAction = {
  label: string;
  busyLabel: string;
  // Return an error string to show it on the row, or null when it worked.
  run: (wo: WorkOrder) => Promise<string | null>;
  // Which tickets get the button.
  when: (wo: WorkOrder) => boolean;
};

export default function WorkOrderList({
  query,
  hrefBase,
  action,
  emptyText = 'Nothing here yet.',
  showTruckCount = false,
  refreshKey = 0,
}: {
  query: string;
  hrefBase: string;
  action?: ListAction;
  emptyText?: string;
  showTruckCount?: boolean;
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError('');
      try {
        const res = await fetch(`/api/work-orders${query}`, { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!json.ok) { setError(json.error || 'Could not load tickets.'); setRows([]); return; }
        setRows(json.work_orders as WorkOrder[]);
      } catch {
        if (!cancelled) { setError('Could not load tickets.'); setRows([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [query, reload, refreshKey]);

  // How many distinct trucks are working each job — what the funder wants to
  // see next to an order.
  const trucksByJob = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const wo of rows || []) {
      if (!wo.job_number || !wo.unit_number) continue;
      const set = m.get(wo.job_number) || new Set<string>();
      set.add(wo.unit_number);
      m.set(wo.job_number, set);
    }
    return m;
  }, [rows]);

  async function runAction(wo: WorkOrder) {
    if (!action) return;
    setBusyId(wo.id);
    setRowError((e) => ({ ...e, [wo.id]: '' }));
    const err = await action.run(wo);
    setBusyId(null);
    if (err) setRowError((e) => ({ ...e, [wo.id]: err }));
    else setReload((n) => n + 1);
  }

  if (rows === null) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (rows.length === 0) return <p className="text-sm text-gray-500">{emptyText}</p>;

  return (
    <div className="space-y-2">
      {rows.map((wo) => {
        const trucks = wo.job_number ? (trucksByJob.get(wo.job_number)?.size ?? 0) : 0;
        return (
          <div key={wo.id} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
            <div className="flex justify-between items-start gap-3 flex-wrap">
              <div className="min-w-0">
                <Link href={`${hrefBase}/${wo.id}`} className="font-medium text-sm hover:text-brand-700">
                  {wo.job_number ? `Job ${wo.job_number}` : 'Untitled ticket'}
                  {wo.day_number ? ` · Day ${wo.day_number}` : ''}
                </Link>
                {wo.order_mismatch && !wo.mismatch_cleared_at && (
                  <div className="text-xs text-red-700 font-medium mt-0.5">
                    Doesn&apos;t match its order: {wo.order_mismatch}
                  </div>
                )}
                <div className="text-xs text-gray-500 mt-0.5">
                  {[
                    wo.job_name || null,
                    wo.job_date,
                    wo.unit_number ? `Unit ${wo.unit_number}` : null,
                    wo.phase_code ? `Phase ${wo.phase_code}` : null,
                    wo.equipment_type || null,
                    wo.fsr ? `FSR ${wo.fsr}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                <div className="text-xs text-gray-600 mt-1 tabular-nums">
                  {billableQuantity(wo).toFixed(2)} {billableUnit(wo)}
                  {wo.rate ? ` × $${Number(wo.rate).toFixed(2)}` : ''}
                  {' = '}
                  <span className="font-semibold">${ticketAmount(wo).toFixed(2)}</span>
                  {billableUnit(wo) !== 'hrs' && totalHours(wo) > 0 && (
                    <span className="text-gray-400"> · {totalHours(wo).toFixed(2)} hrs worked</span>
                  )}
                </div>
                {wo.rejected_reason && wo.status === 'rejected' && (
                  <div className="text-xs text-red-600 mt-1">Sent back: {wo.rejected_reason}</div>
                )}
              </div>

              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_TONE[wo.status as WorkOrderStatus]}`}>
                  {STATUS_LABEL[wo.status as WorkOrderStatus]}
                </span>
                {wo.qb_invoice_number && (
                  <span className="text-[10px] text-gray-500">QB #{wo.qb_invoice_number}</span>
                )}
                {showTruckCount && trucks > 0 && (
                  <span className="text-[10px] text-gray-600">
                    {trucks} truck{trucks === 1 ? '' : 's'} on this job
                  </span>
                )}
                {wo.contractor_approved_at && (
                  <span className="text-[10px] text-emerald-700">Contractor ✓</span>
                )}
                {action && action.when(wo) && (
                  <button
                    onClick={() => runAction(wo)}
                    disabled={busyId === wo.id}
                    className="px-2.5 py-1 text-xs bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
                  >
                    {busyId === wo.id ? action.busyLabel : action.label}
                  </button>
                )}
                {rowError[wo.id] && <span className="text-[10px] text-red-600 max-w-[200px] text-right">{rowError[wo.id]}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
