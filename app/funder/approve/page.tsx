'use client';
import WorkOrderList, { type ListAction } from '@/components/WorkOrderList';
import type { WorkOrder } from '@/lib/work-orders';

// Approve funds against the tickets the office has already audited and
// approved. This is the step the Bill of Sale used to be.

export default function FunderApprovePage() {
  const approveFunds: ListAction = {
    label: 'Approve funds',
    busyLabel: 'Approving…',
    when: (wo: WorkOrder) => wo.status === 'office_approved',
    run: async (wo: WorkOrder) => {
      const res = await fetch(`/api/work-orders/${wo.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as: 'funder' }),
      });
      const json = await res.json();
      return json.ok ? null : (json.error || 'Could not approve funds');
    },
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Approve funds</h1>
      <p className="text-sm text-gray-500 mb-4">
        Tickets the office has audited and approved. Approving funds releases them.
      </p>
      <WorkOrderList
        query="?status=office_approved"
        hrefBase="/funder"
        action={approveFunds}
        showTruckCount
        emptyText="Nothing waiting on funds."
      />
    </div>
  );
}
