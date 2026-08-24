import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';
import MissingReceiptsBanner from '@/components/MissingReceiptsBanner';

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
  if (profile.role === 'salesman') redirect('/salesman');
  if (profile.role === 'customer') redirect('/shop');

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as 'driver' | 'office' | 'mechanic' | 'labor'} email={profile.email} />
      <MissingReceiptsBanner />
      <FeatureGuard group="driver" />
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
