// The funder's side (Auto 1): every ticket that's been created, how many trucks
// are on each job, and the approve-funds button that replaces the emailed
// ticket → Bill of Sale loop.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

const ALLOWED = ['funder', 'admin', 'master_admin'];

export default async function FunderLayout({ children }: { children: React.ReactNode }) {
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
    if (profile.role === 'customer') redirect('/no-access');
    if (profile.role === 'contractor') redirect('/contractor');
    if (profile.role === 'office') redirect('/work-orders');
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
