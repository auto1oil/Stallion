// The Fleet tab fills everything under the nav with the One Glovebox fleet
// panel, so this layout is the full-height variant: no page gutter, no max
// width — the frame gets the whole space.

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
  // The fleet program is Stallion's own trucks. Hauling companies run their
  // own fleets, so their people stay on their side of the app.
  if (profile.role === 'hauler') redirect('/hauler');
  if (profile.hauler_id) redirect('/tickets');

  const group = navGroupForRole(profile.role);

  return (
    <div className="flex h-[100dvh] flex-col bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      {group && <FeatureGuard group={group} />}
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
