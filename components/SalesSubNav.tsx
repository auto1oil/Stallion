'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Salesman sub-navigation mirroring the admin Salesman group: their visit log,
// their hours, and their commissions. Shown at the top of those three pages.
export default function SalesSubNav() {
  const pathname = usePathname() || '';
  const tabs = [
    { href: '/salesman', label: 'Visit log' },
    { href: '/salesman/hours', label: 'Hours' },
    { href: '/salesman/earnings', label: 'Commissions' },
  ];
  return (
    <div className="flex gap-2 mb-4">
      {tabs.map((t) => {
        const active = t.href === '/salesman'
          ? pathname === '/salesman'
          : (pathname === t.href || pathname.startsWith(t.href + '/'));
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
