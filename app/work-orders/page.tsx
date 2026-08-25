'use client';
import { useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import WorkOrderList from '@/components/WorkOrderList';

// The office's saved sheet: every ticket in the system, filtered by stage.
// Submitted → Approve tab; the rest are here for lookup and re-invoicing.

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'submitted', label: 'Waiting on office' },
  { key: 'office_approved', label: 'Approved' },
  { key: 'funds_approved', label: 'Funds approved' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'rejected', label: 'Sent back' },
  { key: 'draft', label: 'Drafts' },
] as const;

export default function WorkOrdersPage() {
  const [filter, setFilter] = useState<string>('');

  // Retry an invoice that QuickBooks rejected when the ticket was approved.
  const invoiceAction = {
    label: 'Invoice',
    busyLabel: 'Invoicing…',
    when: (wo: { status: string; qb_invoice_id: string | null }) =>
      !wo.qb_invoice_id && (wo.status === 'office_approved' || wo.status === 'funds_approved'),
    run: async (wo: { id: string }) => {
      const res = await fetch(`/api/work-orders/${wo.id}/invoice`, { method: 'POST' });
      const json = await res.json();
      return json.ok ? null : (json.error || 'QuickBooks invoice failed');
    },
  };

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
      <h1 className="text-2xl font-semibold mb-3">Tickets</h1>

      <div className="flex gap-2 mb-4 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              filter === f.key
                ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                : 'bg-white border-gray-300 hover:bg-gray-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <WorkOrderList
        query={filter ? `?status=${encodeURIComponent(filter)}` : ''}
        hrefBase="/work-orders"
        action={invoiceAction}
        emptyText="No tickets in this bucket."
      />
    </div>
  );
}
