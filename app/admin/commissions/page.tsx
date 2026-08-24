'use client';

// Admin payout report — every salesman's gross profit + commission owed for the
// selected month, with a per-customer breakdown. Lives under the Salesman tab
// (Visit log / Hours / Commissions).

import AdminSubNav from '@/components/AdminSubNav';
import CommissionsView from '@/components/CommissionsView';

export default function AdminCommissionsPage() {
  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/admin/sales-log', label: 'Visit log' },
          { href: '/admin/hours', label: 'Hours' },
          { href: '/admin/commissions', label: 'Commissions' },
        ]}
      />
      <h1 className="text-2xl font-semibold mb-1">Commissions</h1>
      <p className="text-sm text-gray-500 mb-4">What each salesman earned this month on their assigned customers — what you need to pay them.</p>
      <CommissionsView />
    </div>
  );
}
