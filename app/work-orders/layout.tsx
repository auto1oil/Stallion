// The office's side: review submitted tickets, fix what needs fixing, approve,
// and invoice the customer in QuickBooks. Admins get in here too.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

const ALLOWED = ['office', 'admin', 'master_admin'];

export default async function WorkOrdersLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');

  if (!ALLOWED.includes(profile.role)) {
    if (profile.role === 'customer') redirect('/shop');
    if (profile.role === 'contractor') redirect('/contractor');
    if (profile.role === 'funder') redirect('/funder');
    redirect('/tickets');
  }

  const group = navGroupForRole(profile.role);

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      {group && <FeatureGuard group={group} />}
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
