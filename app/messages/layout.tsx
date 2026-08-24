import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';

export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');
  if (profile.role === 'customer') redirect('/shop/messages');

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as 'admin' | 'driver' | 'salesman' | 'master_admin'} email={profile.email} />
      <main className="max-w-5xl mx-auto px-4 py-3">{children}</main>
    </div>
  );
}
