'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import NotificationBell from './NotificationBell';
import MessageBubble from './MessageBubble';
import { navGroupForRole, featureKey, type Role } from '@/lib/feature-catalog';

const supabase = createClient();

export default function NavBar({ role, email }: { role: Role; email: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [userId, setUserId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [approvals, setApprovals] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Tabs a master admin has switched off for this role (feature_flags).
  useEffect(() => {
    supabase.from('feature_flags').select('key, enabled').eq('enabled', false).then(({ data }) => {
      setHidden(new Set(((data as { key: string }[]) || []).map((r) => r.key)));
    });
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      setUserId(user?.id || null);
      if (!user) return;
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
      const fn = (data?.full_name || '').trim().split(/\s+/)[0];
      setFirstName(fn || (email ? email.split('@')[0] : ''));
    });
  }, [email]);

  // Red badge on the tab that owns this role's pending approvals: submitted
  // tickets for office/admin, office-approved ones awaiting funds for the
  // funder, submitted ones for the contractor's own crews.
  useEffect(() => {
    const waitingFor: Partial<Record<Role, string>> = {
      admin: 'submitted',
      master_admin: 'submitted',
      office: 'submitted',
      contractor: 'submitted',
      funder: 'office_approved',
    };
    const status = waitingFor[role];
    if (!status) return;
    supabase
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', status)
      .then(({ count }) => setApprovals(count || 0));
  }, [role, pathname]);

  async function logout() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const adminLinks = [
    { href: '/work-orders',           label: 'Work Orders' },
    { href: '/work-orders/approve',   label: 'Approve' },
    { href: '/haulers',               label: 'Haulers' },
    { href: '/admin',                 label: 'Tickets' },
    { href: '/admin/delivery-log',    label: 'Delivery Log' },
    { href: '/admin/customers',       label: 'Customers' },
    { href: '/admin/dashboard',       label: 'Dashboard' },
    { href: '/admin/po',              label: 'PO #' },
    { href: '/admin/hours',           label: 'Time Clock' },
    { href: '/admin/users',           label: 'Users' },
  ];
  // Office reviews + invoices tickets; it doesn't run the rest of the shop.
  const officeLinks = [
    { href: '/work-orders',         label: 'Work Orders' },
    { href: '/work-orders/approve', label: 'Approve' },
    { href: '/haulers',             label: 'Haulers' },
    { href: '/driver/customers',    label: 'Customers' },
    { href: '/driver/hours',        label: 'Hours' },
    { href: '/tasks',               label: 'Tasks' },
    { href: '/reminders',           label: 'Reminders' },
  ];
  // Field crew: fill out tickets, plus the delivery side of the business.
  const driverLinks = [
    { href: '/tickets',               label: 'My Tickets' },
    { href: '/tickets/new',           label: 'New Ticket' },
    { href: '/driver',                label: 'Tickets' },
    { href: '/driver/delivery-log',   label: 'Delivery Log' },
    { href: '/driver/customers',      label: 'Customers' },
    { href: '/driver/hours',          label: 'Hours' },
    { href: '/tasks',                 label: 'Tasks' },
    { href: '/reminders',             label: 'Reminders' },
  ];
  const contractorLinks = [
    { href: '/contractor',           label: 'Work Orders' },
    { href: '/contractor/approvals', label: 'Approvals' },
    { href: '/contractor/rates',     label: 'Rates' },
    { href: '/messages',             label: 'Messages' },
  ];
  // Haulers see only their own company's side of the app.
  const haulerLinks = [
    { href: '/hauler',              label: 'Loads' },
    { href: '/tickets',             label: 'Haul Tickets' },
    { href: '/hauler/equipment',    label: 'Trucks & Equipment' },
    { href: '/hauler/availability', label: 'Availability' },
    { href: '/messages',            label: 'Messages' },
  ];
  const funderLinks = [
    { href: '/funder',         label: 'Orders' },
    { href: '/funder/approve', label: 'Approve Funds' },
  ];
  // Mechanic / labor are hourly staff: clock in + tasks/reminders.
  const hourlyLinks = [
    { href: '/driver/hours', label: 'Hours' },
    { href: '/tasks',        label: 'Tasks' },
    { href: '/reminders',    label: 'Reminders' },
  ];
  const baseLinks =
    role === 'admin' || role === 'master_admin'
      ? adminLinks
      : role === 'office'
      ? officeLinks
      : role === 'contractor'
      ? contractorLinks
      : role === 'funder'
      ? funderLinks
      : role === 'hauler'
      ? haulerLinks
      : role === 'driver' || role === 'mechanic'
      ? driverLinks
      : hourlyLinks;
  // Hide tabs a master admin switched off for this role. (Reminders &
  // Permissions live on the Dashboard, not the top nav.)
  // Which tab wears the pending-approval badge for this role.
  const approvalsHref =
    role === 'contractor' ? '/contractor/approvals'
    : role === 'funder' ? '/funder/approve'
    : '/work-orders/approve';
  const group = navGroupForRole(role);
  const links = group ? baseLinks.filter((l) => !hidden.has(featureKey(group, l.href))) : baseLinks;

  function isActive(href: string): boolean {
    if (!pathname) return false;
    if (['/admin', '/driver', '/tickets', '/work-orders', '/contractor', '/funder', '/haulers', '/hauler'].includes(href)) {
      return pathname === href;
    }
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
      {/* yellow accent stripe at the top — Stallion brand touch */}
      <div className="h-1 bg-accent-400" />

      <div className="max-w-5xl mx-auto px-4">
        {/* Row 1 — logo on the left, bell + email + sign out on the right. */}
        <div className="flex items-center justify-between py-3 gap-3">
          <Link href="/" className="shrink-0 inline-flex items-center" aria-label="Stallion — Home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/stallion-logo.svg"
              alt="Stallion"
              className="h-9 w-auto"
            />
          </Link>
          <div className="flex items-center gap-3 shrink-0">
            {userId && <MessageBubble userId={userId} href="/messages" />}
            {userId && <NotificationBell userId={userId} />}
            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              className="text-gray-500 hover:text-brand-700"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
            <Link
              href="/account"
              title={email}
              className="text-sm text-gray-600 hover:text-gray-900 hidden sm:inline"
            >
              {firstName || email}
            </Link>
            <button
              onClick={logout}
              className="text-sm text-gray-600 hover:text-brand-700 whitespace-nowrap"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Row 2 — tabs wrap onto multiple rows so nothing runs off-screen. */}
        <nav className="flex flex-wrap gap-1 pb-2">
          {links.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={[
                  'px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors',
                  active
                    ? 'bg-brand-50 text-brand-700 font-semibold'
                    : 'text-gray-700 hover:bg-accent-50 hover:text-brand-700',
                ].join(' ')}
              >
                {l.label}
                {l.href === approvalsHref && approvals > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold bg-red-500 text-white rounded-full align-middle">
                    {approvals > 9 ? '9+' : approvals}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
