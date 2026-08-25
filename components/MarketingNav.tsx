'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Public top nav for the marketing page. Everyone who signs in is staff, so
// there's one way into the app.
export default function MarketingNav() {
  const pathname = usePathname() || '';
  const link = (href: string, label: string) => {
    const active = pathname === href;
    return (
      <Link
        href={href}
        className={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap ${
          active ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-gray-700 hover:bg-accent-50 hover:text-brand-700'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
      <div className="h-1 bg-accent-400" />
      <div className="max-w-5xl mx-auto px-4 flex items-center justify-between gap-3 py-3">
        <Link href="/home" className="shrink-0 inline-flex items-center" aria-label="Stallion Tank — Home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/stallion-logo.png" alt="Stallion Tank" className="h-9 w-auto" />
        </Link>
        <nav className="flex items-center gap-1 flex-wrap justify-end">
          {link('/home', 'Home')}
          <Link
            href="/login"
            className="ml-1 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 whitespace-nowrap"
          >
            Sign in →
          </Link>
        </nav>
      </div>
    </header>
  );
}
