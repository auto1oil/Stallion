'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import CustomersSubNav from '@/components/CustomersSubNav';
import StaffCustomerList from '@/components/StaffCustomerList';

export default function MyCustomersPage() {
  const supabase = createClient();
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setMeId(user?.id || null));
  }, []);

  return (
    <div>
      <CustomersSubNav />
      <h1 className="text-2xl font-semibold mb-1">My customers</h1>
      <p className="text-sm text-gray-500 mb-4">
        Businesses assigned to you. Toggle to the whole list any time, and upload any missing
        documents you can get. Shaded businesses haven&apos;t ordered in over nine months.
      </p>
      {meId && <StaffCustomerList meId={meId} canToggleMine orderPath="/salesman/order" />}
    </div>
  );
}
