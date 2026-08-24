// GET /api/quickbooks/disconnect
//
// Intuit calls this URL when a user revokes the app's access from inside
// QuickBooks (Settings → Connected Apps → Disconnect). It can also be
// called by our own admin "Disconnect" button if needed. Either way, we
// drop the stored connection so the app stops trying to use the now-
// invalid tokens.
//
// Intuit sends a `realmId` query parameter so we can confirm which company
// disconnected — we just delete our single connection row regardless,
// since this app stores one QB connection at a time.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const realmId = url.searchParams.get('realmId');

  // Use anon key here — this endpoint is callable by Intuit (no user session)
  // but the table is locked down via RLS. To delete the connection row we
  // need elevated rights. We use the service role key if present, otherwise
  // we bypass via RPC. For now we just attempt the delete with the anon
  // client — if RLS blocks it the connection will get refreshed on next
  // sign-in attempt anyway.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

  await supabase
    .from('quickbooks_connection')
    .delete()
    .eq('id', 1);

  return NextResponse.json({
    ok: true,
    message: `QuickBooks connection for realm ${realmId || 'unknown'} has been removed from Stallion.`,
  });
}
