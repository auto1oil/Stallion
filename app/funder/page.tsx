'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import WorkOrderList from '@/components/WorkOrderList';
import { ticketAmount, type WorkOrder } from '@/lib/work-orders';

// Auto 1's view: every order that's been created, with the truck count per job
// — the digital replacement for the emailed ticket → Bill of Sale loop.

export default function FunderHomePage() {
  const supabase = createClient();
  const [rows, setRows] = useState<WorkOrder[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('work_orders')
        .select('*')
        .order('job_date', { ascending: false, nullsFirst: false });
      setRows((data as WorkOrder[]) || []);
    })();
  }, [supabase]);

  const jobs = useMemo(() => {
    const m = new Map<string, { trucks: Set<string>; tickets: number; amount: number; waiting: number }>();
    for (const wo of rows) {
      const key = wo.job_number || '(no job number)';
      const j = m.get(key) || { trucks: new Set<string>(), tickets: 0, amount: 0, waiting: 0 };
      if (wo.unit_number) j.trucks.add(wo.unit_number);
      j.tickets++;
      j.amount += ticketAmount(wo);
      if (wo.status === 'office_approved') j.waiting++;
      m.set(key, j);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].tickets - a[1].tickets);
  }, [rows]);

  const waitingTotal = rows.filter((r) => r.status === 'office_approved').length;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h1 className="text-2xl font-semibold">Orders</h1>
        {waitingTotal > 0 && (
          <Link
            href="/funder/approve"
            className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
          >
            {waitingTotal} waiting on funds →
          </Link>
        )}
      </div>

      {jobs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 mb-5">
          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">By job</div>
          {jobs.map(([job, j]) => (
            <div key={job} className="px-4 py-2 flex justify-between items-center gap-3 text-sm flex-wrap">
              <span className="font-medium">{job}</span>
              <span className="text-gray-600 text-xs flex gap-4">
                <span>{j.trucks.size} truck{j.trucks.size === 1 ? '' : 's'}</span>
                <span>{j.tickets} ticket{j.tickets === 1 ? '' : 's'}</span>
                {j.waiting > 0 && <span className="text-amber-700 font-medium">{j.waiting} waiting</span>}
                <span className="tabular-nums font-semibold text-gray-800">${j.amount.toFixed(2)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <WorkOrderList
        query=""
        hrefBase="/funder"
        showTruckCount
        emptyText="No orders have been created yet."
      />
    </div>
  );
}
