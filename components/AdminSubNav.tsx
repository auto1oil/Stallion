'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// A small sub-navigation shown at the top of grouped staff pages (e.g. Work
// orders → All tickets / Approve / Setup). Hidden for anyone outside `roles`,
// so a shared page looks unchanged to everyone else.
const DEFAULT_ROLES = ['admin', 'master_admin'];

export default function AdminSubNav({
  tabs,
  roles = DEFAULT_ROLES,
}: {
  tabs: { href: string; label: string }[];
  roles?: string[];
}) {
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

  if (!role || !roles.includes(role)) return null;

  // With nested tabs (/work-orders and /work-orders/approve) a plain prefix
  // test lights up both. The longest matching href is the real one.
  const activeHref = tabs
    .filter((t) => pathname === t.href || (!!pathname && pathname.startsWith(t.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="flex gap-2 mb-4">
      {tabs.map((t) => {
        const active = t.href === activeHref;
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
