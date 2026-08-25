// The hauler's own side: the loads dispatch has sent them, the trucks and
// equipment they've put on file, and the dates they're blocked out.
//
// Everything here is scoped to the signed-in user's hauler company, so a
// second dispatcher at the same company sees the same fleet and the same
// loads. Office and admin can look in; the directory itself is /haulers.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import { navGroupForRole, type Role } from '@/lib/feature-catalog';

const ALLOWED = ['hauler', 'office', 'admin', 'master_admin'];

export default async function HaulerLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email, hauler_id')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');

  if (!ALLOWED.includes(profile.role)) {
    if (profile.role === 'customer') redirect('/no-access');
    if (profile.role === 'funder') redirect('/funder');
    if (profile.role === 'contractor') redirect('/contractor');
    redirect('/tickets');
  }

  // A hauler login with no company attached can't see anything and can't fix
  // it themselves — say so plainly instead of showing empty screens.
  if (profile.role === 'hauler' && !profile.hauler_id) {
    return (
      <div className="min-h-screen bg-gray-50">
        <NavBar role={profile.role as Role} email={profile.email} />
        <main className="max-w-5xl mx-auto px-4 py-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
            <h1 className="text-lg font-semibold mb-2">Your login isn&apos;t linked to a company yet</h1>
            <p className="text-sm text-gray-600">
              Ask the Stallion office to attach your login to your hauling
              company. Once they do, your loads and fleet show up here.
            </p>
          </div>
        </main>
      </div>
    );
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
