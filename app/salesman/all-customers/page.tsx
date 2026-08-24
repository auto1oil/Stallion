'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import CustomersSubNav from '@/components/CustomersSubNav';
import VisitForm from '@/components/VisitForm';
import StaffCustomerList from '@/components/StaffCustomerList';

export default function AllCustomersPage() {
  const supabase = createClient();
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [names, setNames] = useState<string[]>([]);
  // null = closed; '' opens a blank visit form; a name pre-fills it.
  const [logPrefill, setLogPrefill] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles').select('full_name, email').eq('id', user.id).single();
        setMe({ id: user.id, name: profile?.full_name || profile?.email || 'Salesman' });
      }
      // Business names only — for the visit-form autocomplete.
      const { data } = await supabase.from('businesses').select('name').order('name');
      setNames(((data as { name: string }[]) || []).map((b) => b.name));
    })();
  }, []);

  const suggestions = useMemo(() => names.map((name) => ({ name, city: null })), [names]);

  return (
    <div>
      <CustomersSubNav />
      <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Customers</h1>
          <p className="text-sm text-gray-500">
            Toggle your own customers or the whole list. Upload any missing documents you can get.
          </p>
        </div>
        <button
          onClick={() => setLogPrefill('')}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 font-medium whitespace-nowrap"
        >
          + Log visit
        </button>
      </div>

      {me && <StaffCustomerList meId={me.id} canToggleMine orderPath="/salesman/order" />}

      {logPrefill !== null && me && (
        <VisitForm
          visit={null}
          salesmanId={me.id}
          salesmanName={me.name}
          suggestions={suggestions}
          defaultBusinessName={logPrefill || undefined}
          onClose={() => setLogPrefill(null)}
          onSaved={() => setLogPrefill(null)}
        />
      )}
    </div>
  );
}
