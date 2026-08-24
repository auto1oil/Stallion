'use client';

// Salesman stock list — description, quantity on hand, and retail price (no cost).

import StaffInventoryList from '@/components/StaffInventoryList';

export default function SalesmanInventoryPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Inventory</h1>
      <p className="text-sm text-gray-500 mb-4">What&apos;s on hand and the retail price, to quote customers.</p>
      <StaffInventoryList />
    </div>
  );
}
