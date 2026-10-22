// Charges: a driver (or anyone on staff) records a fuel or misc purchase with
// its scanned receipt. Customers and funders have no business here; hauler
// companies pay their own fuel, so their logins are bounced home too.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

export default async function ChargesLayout({ children }: { children: React.ReactNode }) {
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
  if (profile.role === 'funder') redirect('/funder');
  if (profile.role === 'hauler' || profile.hauler_id) redirect('/');

  const group = navGroupForRole(profile.role);

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      {group && <FeatureGuard group={group} />}
      <main>{children}</main>
    </div>
  );
}
