// POST /api/bills/sync-ap — mirror open QuickBooks A/P into the bills list.
//
// Admin only. Lighter than the full "Sync bills" (no email/Graph): just pulls
// open QuickBooks bills into the Unpaid (Due) list and marks settled ones paid.
// The Bills page calls this on load so the Due list populates without a tap.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { syncOpenBillsFromQuickBooks } from '@/lib/quickbooks-bills';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    // Run under the admin's session — they have RLS access to both
    // quickbooks_connection and vendor_bills (the service-role role isn't
    // granted on quickbooks_connection).
    const result = await syncOpenBillsFromQuickBooks(supabase);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
