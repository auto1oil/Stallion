'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import WorkOrderList from '@/components/WorkOrderList';
import AuditQueue from '@/components/AuditQueue';
import FilterBar, { EMPTY_FILTER, matchesTicket, type ListFilter } from '@/components/FilterBar';
import { createClient } from '@/lib/supabase-browser';
import type { WorkOrder } from '@/lib/work-orders';

// The office's working tab. Tickets needing approval are dumped straight in
// at the top — the audit queue — with the full ticket sheet below it for
// lookup and re-invoicing. The Approve subtab is the same queue on its own.

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
  const [bar, setBar] = useState<ListFilter>(EMPTY_FILTER);
  const [haulers, setHaulers] = useState<{ id: string; name: string }[]>([]);
  const [matched, setMatched] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    supabase.from('haulers').select('id, name').order('name')
      .then(({ data }) => setHaulers((data as { id: string; name: string }[]) || []));
  }, []);

  const filterFn = useMemo(() => (wo: WorkOrder) => matchesTicket(bar, wo), [bar]);
  const onCounts = useCallback((m: number, t: number) => { setMatched(m); setTotal(t); }, []);

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

      {/* What's waiting on the office, front and center. */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Needing approval
        </h2>
        <AuditQueue />
      </section>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
        All tickets
      </h2>
      <FilterBar value={bar} onChange={setBar} haulers={haulers} matched={matched} total={total} />
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
        filterFn={filterFn}
        onCounts={onCounts}
      />
    </div>
  );
}
