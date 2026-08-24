import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import MessagesView from '@/components/MessagesView';

export const dynamic = 'force-dynamic';

export default async function CustomerMessagesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/shop/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, email, business_id')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/shop/login');

  // Make sure the customer has a thread to talk through: prefer their
  // business's assigned sales rep, otherwise fall back to an admin. ensure_dm
  // is idempotent (find-or-create), so this is safe to run on every load.
  let contactId: string | null = null;
  if (profile.business_id) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('assigned_sales_rep_id')
      .eq('id', profile.business_id)
      .maybeSingle();
    contactId = (biz as { assigned_sales_rep_id: string | null } | null)?.assigned_sales_rep_id ?? null;
  }
  if (!contactId) {
    const { data: admin } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'master_admin'])
      .limit(1)
      .maybeSingle();
    contactId = (admin as { id: string } | null)?.id ?? null;
  }
  if (contactId) {
    await supabase.rpc('ensure_dm', { other: contactId });
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-2">Messages</h1>
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <MessagesView me={{ id: user.id, role: profile.role, name: profile.full_name, email: profile.email }} />
      </Suspense>
    </div>
  );
}
