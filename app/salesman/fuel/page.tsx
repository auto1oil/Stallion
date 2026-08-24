'use client';

// Salesman fuel prices — the same "Today's Fuel Prices" box drivers see, so
// reps can quote customers. Read-only (no cost, no editing).

import FuelPricesWidget from '@/components/FuelPricesWidget';

export default function SalesmanFuelPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">Fuel prices</h1>
      <p className="text-sm text-gray-500 mb-4">Today&apos;s prices to quote customers.</p>
      <FuelPricesWidget />
    </div>
  );
}
