'use client';
import TruckingCreate from '@/components/TruckingCreate';

// Driver Trucking tab — create a freight invoice + see what's en route.
export default function DriverTruckingPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold text-gray-900">Trucking</h1>
      <TruckingCreate orderHrefBase="/driver/order" />
    </div>
  );
}
