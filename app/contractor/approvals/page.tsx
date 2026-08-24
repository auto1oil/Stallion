'use client';
import ContractorSubNav from '@/components/ContractorSubNav';
import WorkOrderList, { type ListAction } from '@/components/WorkOrderList';
import type { WorkOrder } from '@/lib/work-orders';

// The contractor signs off on their crews' days and hours. This is their own
// approval — it sits alongside the office/funder chain rather than gating it.

export default function ContractorApprovalsPage() {
  const approve: ListAction = {
    label: 'Approve',
    busyLabel: 'Approving…',
    when: (wo: WorkOrder) => !wo.contractor_approved_at && wo.status !== 'draft' && wo.status !== 'rejected',
    run: async (wo: WorkOrder) => {
      const res = await fetch(`/api/work-orders/${wo.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as: 'contractor' }),
      });
      const json = await res.json();
      return json.ok ? null : (json.error || 'Could not record the approval');
    },
  };

  return (
    <div>
      <ContractorSubNav />
      <h1 className="text-2xl font-semibold mb-1">Approvals</h1>
      <p className="text-sm text-gray-500 mb-4">
        Your crews&apos; submitted days and hours. Approving marks your sign-off on a ticket; the office
        still audits and invoices it.
      </p>
      <WorkOrderList
        query="?status=submitted,office_approved,funds_approved,invoiced"
        hrefBase="/contractor"
        action={approve}
        emptyText="Nothing waiting on you."
      />
    </div>
  );
}
