'use client';

// Driver-side customer list. Same detail as the salesman view (missing
// documents, order cadence, inactive shading) minus balance owed. Drivers
// aren't assigned to customers, so there's no "my customers" toggle — they see
// the whole list and can upload a document if they pick one up on a delivery.

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import StaffCustomerList from '@/components/StaffCustomerList';

export default function DriverCustomersPage() {
  const supabase = createClient();
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setMeId(user?.id || null));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Customers</h1>
      <p className="text-sm text-gray-500 mb-4">
        The whole customer list. Upload any missing documents you can collect on a delivery.
        Shaded businesses haven&apos;t ordered in over nine months — worth a nudge.
      </p>
      {meId && <StaffCustomerList meId={meId} canToggleMine={false} />}
    </div>
  );
}
