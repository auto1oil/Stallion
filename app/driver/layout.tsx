import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

export default async function DriverLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();

  if (!profile) redirect('/login');

  // Admins and master admins shouldn't be in driver area — bounce to admin
  if (profile.role === 'admin' || profile.role === 'master_admin') {
    redirect('/admin');
  }
  if (profile.role === 'contractor') redirect('/contractor');
  if (profile.role === 'hauler') redirect('/hauler');
  if (profile.role === 'funder') redirect('/funder');
  if (profile.role === 'customer') redirect('/no-access');

  // Office shares the crew's customer directory + time clock but keeps its own
  // tab set, so the guard follows the role rather than the folder.
  const group = navGroupForRole(profile.role) || 'driver';

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      <FeatureGuard group={group} />
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
