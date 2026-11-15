// Stallion's own fleet — trucks, fuel, trips, service, documents. The fleet
// is the company's iron: hauling companies manage their trucks on their own
// side, so hauler-side logins are bounced out before the page loads (RLS
// would show them nothing anyway).

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

export default async function FleetLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email, hauler_id')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');
  if (profile.role === 'customer') redirect('/no-access');
  if (profile.role === 'hauler') redirect('/hauler');
  if (profile.hauler_id) redirect('/tickets');
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
