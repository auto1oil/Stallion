import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();

  if (!profile || (profile.role !== 'admin' && profile.role !== 'master_admin')) {
    if (profile?.role === 'customer') redirect('/shop');
    if (profile?.role === 'salesman') redirect('/salesman');
    if (['office', 'labor'].includes(profile?.role || '')) redirect('/driver/hours');
    redirect('/driver');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as 'admin' | 'master_admin'} email={profile.email} />
      <FeatureGuard group="admin" />
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
