'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import ContractorSubNav from '@/components/ContractorSubNav';
import WorkOrderList from '@/components/WorkOrderList';
import { totalHours, ticketAmount, type WorkOrder } from '@/lib/work-orders';

// What the contractor's crews have filed: the days and hours submitted, the
// finished work orders, and what it all comes to.

export default function ContractorHomePage() {
  const supabase = createClient();
  const [rows, setRows] = useState<WorkOrder[]>([]);

  useEffect(() => {
    (async () => {
      // RLS narrows this to the contractor's own crews.
      const { data } = await supabase
        .from('work_orders')
        .select('*')
        .order('job_date', { ascending: false, nullsFirst: false });
      setRows((data as WorkOrder[]) || []);
    })();
  }, [supabase]);

  const summary = useMemo(() => {
    const days = new Set<string>();
    let hours = 0;
    let amount = 0;
    let finished = 0;
    for (const wo of rows) {
      if (wo.job_date) days.add(`${wo.job_date}|${wo.unit_number || ''}`);
      hours += totalHours(wo);
      amount += ticketAmount(wo);
      if (wo.status === 'invoiced' || wo.status === 'funds_approved') finished++;
    }
    return { days: days.size, hours, amount, finished, total: rows.length };
  }, [rows]);

  return (
    <div>
      <ContractorSubNav />
      <h1 className="text-2xl font-semibold mb-3">Work orders</h1>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {[
          { label: 'Tickets', value: String(summary.total) },
          { label: 'Crew days', value: String(summary.days) },
          { label: 'Hours', value: summary.hours.toFixed(2) },
          { label: 'Finished', value: String(summary.finished) },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-lg px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">{s.label}</div>
            <div className="text-lg font-semibold tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      <WorkOrderList
        query=""
        hrefBase="/contractor"
        emptyText="None of your crews have filed a ticket yet."
      />
    </div>
  );
}
