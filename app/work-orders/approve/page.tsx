'use client';
import AdminSubNav from '@/components/AdminSubNav';
import WorkOrderList from '@/components/WorkOrderList';

// The audit queue: everything the crew has submitted and nobody has looked at
// yet. Open one to check it against the ticket photo, fix what's wrong, and
// approve — which invoices the customer in QuickBooks.

export default function ApproveQueuePage() {
  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/work-orders', label: 'All tickets' },
          { href: '/work-orders/approve', label: 'Approve' },
          { href: '/work-orders/orders', label: 'Orders' },
          { href: '/work-orders/setup', label: 'Setup' },
        ]}
        roles={['office', 'admin', 'master_admin']}
      />
      <h1 className="text-2xl font-semibold mb-1">Waiting for review</h1>
      <p className="text-sm text-gray-500 mb-4">
        Open a ticket to check it against the photo, fix anything that&apos;s off, then approve — that
        invoices the customer in QuickBooks.
      </p>
      <WorkOrderList
        query="?status=submitted"
        hrefBase="/work-orders"
        emptyText="Nothing waiting — the queue is clear."
      />
    </div>
  );
}
