import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import CustomerNavBar from '@/components/CustomerNavBar';
import FeatureGuard from '@/components/FeatureGuard';

export default async function CustomerShopLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/shop/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email, business_id')
    .eq('id', user.id)
    .single();

  if (!profile) redirect('/shop/login');

  // Employees don't belong here — bounce them to their own area
  if (profile.role === 'admin' || profile.role === 'master_admin') redirect('/admin');
  if (profile.role === 'contractor') redirect('/contractor');
  if (profile.role === 'funder') redirect('/funder');
  if (profile.role === 'driver') redirect('/driver');

  // If the customer signed up claiming an existing business but hasn't been
  // approved yet, surface a banner across the shop so they know why they
  // can't check out yet.
  let pendingLinkClaim: string | null = null;
  if (!profile.business_id) {
    const { data: pending } = await supabase
      .from('business_link_requests')
      .select('id, claimed_name, businesses:business_id(name)')
      .eq('profile_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (pending) {
      // PostgREST returns the join as an array even on many-to-one.
      const row = pending as { claimed_name?: string | null; businesses?: { name: string }[] | { name: string } | null };
      const biz = Array.isArray(row.businesses) ? row.businesses[0] : row.businesses;
      pendingLinkClaim = biz?.name || row.claimed_name || 'your business';
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <CustomerNavBar email={profile.email} />
      <FeatureGuard group="customer" />
      {pendingLinkClaim && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-5xl mx-auto px-4 py-2 text-sm text-amber-900">
            <strong>Waiting on admin approval</strong> to link you to{' '}
            <span className="font-medium">{pendingLinkClaim}</span>. You can browse,
            but checkout is locked until we approve your request.
          </div>
        </div>
      )}
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
