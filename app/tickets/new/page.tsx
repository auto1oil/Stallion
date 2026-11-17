'use client';
import WorkOrderForm from '@/components/WorkOrderForm';

export default function NewTicketPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">New haul ticket</h1>
      <p className="text-sm text-gray-500 mb-4">
        Tap your loads in and out, snap each BOL, and have the superintendent
        sign at the end of the day.
      </p>
      <WorkOrderForm workOrder={null} />
    </div>
  );
}
