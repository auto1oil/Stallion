// GET /api/cron/sync-inventory — nightly QuickBooks refresh.
//
// Secured by a bearer token in the Authorization header (CRON_SECRET). Vercel
// Cron sends this automatically when configured in vercel.json. Pulls cost,
// retail price and stock from QuickBooks (the source of truth) for every matched
// item — so prices stay current for quotes/orders — then runs the stock-level
// pass to send low-stock alerts.

import { NextResponse } from 'next/server';
import { syncInventoryFromQuickBooks, syncInventoryLevels } from '@/lib/inventory-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;
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
  try {
    // First pull cost/retail/stock + import any new items, then run the
    // level pass for low-stock notifications.
    const prices = await syncInventoryFromQuickBooks();
    const levels = await syncInventoryLevels();
    return NextResponse.json({ ok: true, prices, levels });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
