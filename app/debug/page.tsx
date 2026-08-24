import { createClient } from '@/lib/supabase-server';

export default async function DebugPage() {
  const supabase = createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  let profile = null;
  let profileError = null;
  if (user) {
    const result = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    profile = result.data;
    profileError = result.error;
  }

  return (
    <div style={{ padding: 20, fontFamily: 'monospace', fontSize: 14 }}>
      <h1>Debug info</h1>
      <h2>Auth user</h2>
      <pre style={{ background: '#eee', padding: 10, overflow: 'auto' }}>
        {JSON.stringify({ user, userError }, null, 2)}
      </pre>
      <h2>Profile lookup</h2>
      <pre style={{ background: '#eee', padding: 10, overflow: 'auto' }}>
        {JSON.stringify({ profile, profileError }, null, 2)}
      </pre>
      <h2>Diagnosis</h2>
      <p>If profile is null but user exists, the RLS policy is blocking the read.</p>
      <p>If profile.role is &apos;driver&apos; but you set it to admin in SQL, you&apos;re looking at the wrong row.</p>
      <p>If user is null, you aren&apos;t signed in here.</p>
    </div>
  );
}

