'use client';
import WorkOrderForm from '@/components/WorkOrderForm';

export default function NewTicketPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">New field ticket</h1>
      <p className="text-sm text-gray-500 mb-4">
        Fill this out on the job. Save a draft any time — submit it when the ticket photo is on it.
      </p>
      <WorkOrderForm workOrder={null} />
    </div>
  );
}
