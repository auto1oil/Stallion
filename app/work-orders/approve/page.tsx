'use client';
import AdminSubNav from '@/components/AdminSubNav';
import AuditQueue from '@/components/AuditQueue';

// The audit queue. Tickets that disagree with their order — or have no order,
// no photo, or nothing to bill — go up top with the reason. The rest have
// already been checked against what was agreed and can be passed in a batch.

export default function ApproveQueuePage() {
  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/work-orders', label: 'All tickets' },
          { href: '/work-orders/approve', label: 'Approve' },
          { href: '/work-orders/setup', label: 'Setup' },
        ]}
        roles={['office', 'admin', 'master_admin']}
      />
      <h1 className="text-2xl font-semibold mb-1">Audit</h1>
      <p className="text-sm text-gray-500 mb-4">
        Completed tickets waiting on the office. Anything that doesn&apos;t line
        up with its order is called out; the rest can be passed in a batch.
      </p>
      <AuditQueue />
    </div>
  );
}
