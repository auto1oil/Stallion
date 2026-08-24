import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import NavBar from '@/components/NavBar';
import FeatureGuard from '@/components/FeatureGuard';

export default async function SalesmanLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single();

  if (!profile) redirect('/login');

  // Admins + drivers can also use the /salesman/order flow to place orders
  // on behalf of customers. They keep their own navbar in that case.
  if (profile.role === 'customer') redirect('/shop');
  // Salesmen landing on /salesman without /order suffix → Log Visit page
  // (already the default). Admins landing on /salesman → bounce them to
  // /admin so they don't see the visit logger by accident.
  // (We can't read the path inside an async layout cleanly, so we leave
  //  admins on this layout — they reach /salesman/order via a direct link
  //  from /admin/customer-orders.)

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar role={profile.role as 'salesman' | 'admin' | 'master_admin' | 'driver'} email={profile.email} />
      <FeatureGuard group="salesman" />
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
