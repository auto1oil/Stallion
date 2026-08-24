'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// A two-option sub-navigation shown to admins at the top of grouped pages
// (e.g. Customers → Existing customers / Customers visited). Hidden for
// non-admins, so shared pages look unchanged to
// salesmen.
export default function AdminSubNav({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setIsAdmin(data?.role === 'admin' || data?.role === 'master_admin');
    });
  }, []);

  if (!isAdmin) return null;

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
