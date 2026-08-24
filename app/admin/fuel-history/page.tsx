'use client';
import { useState } from 'react';
import Link from 'next/link';
import FuelCostHistory from '@/components/FuelCostHistory';
import FuelTaxRatesEditor from '@/components/FuelTaxRatesEditor';

// Dedicated Fuel History tab: the all-in cost-per-gallon history (rack price +
// fixed fuel taxes) plus the editor for the app-side tax rates that feed it.
export default function FuelHistoryPage() {
  const [historyKey, setHistoryKey] = useState(0);
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-2xl font-semibold">Fuel Cost History</h1>
        <Link
          href="/admin/fuel-prices"
          className="text-sm font-medium text-brand-700 hover:bg-brand-50 border border-brand-300 rounded-md px-3 py-1 whitespace-nowrap"
        >
          ← Fuel Pricing
        </Link>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Total cost per gallon over time — the rack price on each date plus the fixed fuel taxes for
        that product. Newest date on top.
      </p>

      <FuelTaxRatesEditor onSaved={() => setHistoryKey((k) => k + 1)} />
      <FuelCostHistory key={historyKey} />
    </div>
  );
}
