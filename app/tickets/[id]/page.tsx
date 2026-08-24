'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { STATUS_LABEL, STATUS_TONE, type WorkOrder, type WorkOrderStatus } from '@/lib/work-orders';
import WorkOrderForm from '@/components/WorkOrderForm';

// One of the crew's own tickets. A draft (or one that was sent back) is fully
// editable; once the office has it, the form goes read-only and this page is
// where the crew sees what happened to it.

export default function TicketDetailPage({ params }: { params: { id: string } }) {
  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/work-orders/${params.id}`, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not load this ticket.'); return; }
      setWo(json.work_order as WorkOrder);
    })();
  }, [params.id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!wo) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div>
      <Link href="/tickets" className="text-sm text-brand-700 hover:underline">← My tickets</Link>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mt-2 mb-1">
        <h1 className="text-2xl font-semibold">
          {wo.job_number ? `Job ${wo.job_number}` : 'Field ticket'}
          {wo.day_number ? ` · Day ${wo.day_number}` : ''}
        </h1>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_TONE[wo.status as WorkOrderStatus]}`}>
          {STATUS_LABEL[wo.status as WorkOrderStatus]}
        </span>
      </div>

      {wo.status === 'rejected' && wo.rejected_reason && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-3">
          Sent back: {wo.rejected_reason}
        </p>
      )}
      {wo.qb_invoice_number && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 mb-3">
          Invoiced in QuickBooks as #{wo.qb_invoice_number}.
        </p>
      )}

      <WorkOrderForm workOrder={wo} onSaved={setWo} />
    </div>
  );
}
