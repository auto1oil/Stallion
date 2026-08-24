// GET /api/cron/poll-bills — scheduled mailbox ingestion (bills + rack prices).
//
// Secured by a bearer token in the Authorization header (CRON_SECRET). Vercel
// Cron sends this automatically when configured in vercel.json. From the one
// configured Microsoft 365 mailbox it pulls (a) vendor-bill emails into the
// review queue and (b) DTN/Sinclair rack-price emails into rack_prices. The two
// never overlap: bills come from attachments, rack prices from the body text.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { ingestBillsFromEmail } from '@/lib/bills-ingest';
import { ingestRackPricesFromEmail } from '@/lib/rack-ingest';
import { syncOpenBillsFromQuickBooks } from '@/lib/quickbooks-bills';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: allow when no secret configured
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  // Run independently so one failing doesn't block the others: pull new bill
  // emails, pull rack prices, and mirror the open QuickBooks A/P into the list.
  const [bills, rack, ap] = await Promise.allSettled([
    ingestBillsFromEmail(),
    ingestRackPricesFromEmail(),
    syncOpenBillsFromQuickBooks(createAdminClient()),
  ]);
  return NextResponse.json({
    ok: true,
    bills: bills.status === 'fulfilled' ? bills.value : { error: String(bills.reason) },
    rack: rack.status === 'fulfilled' ? rack.value : { error: String(rack.reason) },
    ap: ap.status === 'fulfilled' ? ap.value : { error: String(ap.reason) },
  });
}
