'use client';

// Salesman earnings — your own commission for the month, by customer. Numbers
// are locked to you (the API never returns other reps' data). Sits in the
// salesman sub-nav (Visit log / Hours / Commissions).

import CommissionsView from '@/components/CommissionsView';
import SalesSubNav from '@/components/SalesSubNav';

export default function SalesmanEarningsPage() {
  return (
    <div>
      <SalesSubNav />
      <h1 className="text-2xl font-semibold mb-1">My commissions</h1>
      <p className="text-sm text-gray-500 mb-4">Your commission this month, by customer — % of gross profit, plus any per-gallon fuel commission.</p>
      <CommissionsView salesmanView />
    </div>
  );
}
