import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import MessagesView from '@/components/MessagesView';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, email')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');

  return (
    <div>
      <h1 className="text-xl font-semibold mb-2">Messages</h1>
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <MessagesView me={{ id: user.id, role: profile.role, name: profile.full_name, email: profile.email }} />
      </Suspense>
    </div>
  );
}
