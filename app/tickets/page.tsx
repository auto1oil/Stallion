'use client';
import Link from 'next/link';
import { useState } from 'react';
import WorkOrderList from '@/components/WorkOrderList';

// A crew member's own tickets, newest first, filtered by where each one is in
// the approval chain.

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'office_approved,funds_approved,invoiced', label: 'Approved' },
  { key: 'rejected', label: 'Sent back' },
] as const;

export default function MyTicketsPage() {
  const [filter, setFilter] = useState<string>('');

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h1 className="text-2xl font-semibold">My tickets</h1>
        <Link
          href="/tickets/new"
          className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
        >
          + New ticket
        </Link>
      </div>

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
        query={`?mine=1${filter ? `&status=${encodeURIComponent(filter)}` : ''}`}
        hrefBase="/tickets"
        emptyText="No tickets here yet. Tap “New ticket” after your next job."
      />
    </div>
  );
}
