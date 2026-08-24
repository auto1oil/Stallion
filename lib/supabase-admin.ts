import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Server-only Supabase client using the service-role key. Bypasses RLS, so
// it is the right client for unauthenticated server contexts like cron jobs
// and inbound webhooks where there is no user session. Never import this from
// a client component.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
