'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Work orders / Approvals / Rates, across the contractor's three screens.

const TABS = [
  { href: '/contractor', label: 'Work orders' },
  { href: '/contractor/approvals', label: 'Approvals' },
  { href: '/contractor/rates', label: 'Rates' },
];

export default function ContractorSubNav() {
  const pathname = usePathname();
  const activeHref = TABS
    .filter((t) => pathname === t.href || (!!pathname && pathname.startsWith(t.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="flex gap-2 mb-4">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`px-3 py-1.5 text-sm rounded-md border ${
            t.href === activeHref
              ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
              : 'bg-white border-gray-300 hover:bg-gray-50'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
