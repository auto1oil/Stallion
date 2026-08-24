// POST /api/bills/poll — admin-triggered "Check email now" for vendor bills.
//
// Same ingestion as the cron, but gated to a signed-in admin so the office can
// pull bills on demand instead of waiting for the schedule.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { ingestBillsFromEmail } from '@/lib/bills-ingest';
import { syncOpenBillsFromQuickBooks } from '@/lib/quickbooks-bills';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const result = await ingestBillsFromEmail(supabase);
    // Also mirror the open QuickBooks A/P into the list. Runs under the admin's
    // session (RLS access to quickbooks_connection + vendor_bills). Best-effort.
    let ap: { open: number; imported: number; updated: number; closed: number; failed?: number; error?: string } | null = null;
    try { ap = await syncOpenBillsFromQuickBooks(supabase); } catch { /* ignore */ }
    return NextResponse.json({ ok: true, ...result, ap });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
