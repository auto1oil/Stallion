import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import { type Role } from '@/lib/feature-catalog';

export default async function RemindersLayout({ children }: { children: React.ReactNode }) {
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

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as Role} email={profile.email} />
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
