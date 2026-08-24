// The crew's side of the app: fill out a field ticket, see the ones you've
// filed and what the office did with them.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

export default async function TicketsLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');
  if (profile.role === 'customer') redirect('/no-access');
  if (profile.role === 'funder') redirect('/funder');

  const group = navGroupForRole(profile.role);

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      {group && <FeatureGuard group={group} />}
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
