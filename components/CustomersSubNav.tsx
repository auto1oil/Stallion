'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Customers → Existing customers / Customers visited sub-navigation.
// Shown to admins and salesmen (drivers and customers don't get a Customers
// area). The "Existing customers" target differs by role: admins land on the
// QuickBooks-synced /admin/customers, salesmen on the money-free
// /salesman/all-customers list.
export default function CustomersSubNav() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setRole(data?.role ?? null);
    });
  }, []);

  const isAdmin = role === 'admin' || role === 'master_admin';
  const isSalesman = role === 'salesman';
  if (!isAdmin && !isSalesman) return null;

  const tabs = [
    { href: isAdmin ? '/admin/customers' : '/salesman/all-customers', label: 'Existing customers' },
    { href: '/salesman/businesses', label: 'Customers visited' },
  ];

  return (
    <div className="flex gap-2 mb-4">
      {tabs.map((t) => {
        const active = pathname === t.href || (!!pathname && pathname.startsWith(t.href + '/'));
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              active
                ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                : 'bg-white border-gray-300 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
