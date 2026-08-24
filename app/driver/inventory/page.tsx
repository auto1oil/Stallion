'use client';

// Driver inventory — view what's on hand, or switch to Adjust counts to correct
// on-hand levels (updates the app + pushes to QuickBooks).

import { useState } from 'react';
import StaffInventoryList from '@/components/StaffInventoryList';
import InventoryAdjustList from '@/components/InventoryAdjustList';

export default function DriverInventoryPage() {
  const [tab, setTab] = useState<'view' | 'adjust'>('view');
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Inventory</h1>
      <p className="text-sm text-gray-500 mb-3">What&apos;s on hand and the retail price, or adjust the counts.</p>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {([['view', 'View'], ['adjust', 'Adjust counts']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === key ? 'border-brand-700 text-brand-700 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'view' ? <StaffInventoryList /> : <InventoryAdjustList />}
    </div>
  );
}
