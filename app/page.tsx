import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';

export default async function Home() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  // Logged-out visitors land on the public marketing Home.
  if (!user) redirect('/home');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  // Everyone lands where their day's work is. Admin and office land on the
  // tickets board (the audit queue sits on top of it); crew land on their own
  // tickets — including a hauling company's drivers, whose nav is tickets-only.
  if (profile?.role === 'admin' || profile?.role === 'master_admin') redirect('/work-orders');
  if (profile?.role === 'contractor') redirect('/contractor');
  if (profile?.role === 'hauler') redirect('/hauler');
  if (profile?.role === 'funder') redirect('/funder');
  if (profile?.role === 'customer') redirect('/no-access');
  if (profile?.role === 'office') redirect('/work-orders');
  // Labor is hourly staff, so their home is the clock.
  if (profile?.role === 'labor') redirect('/driver/hours');
  redirect('/tickets');
}
