// GET /api/cron/sync-balances — nightly QuickBooks balance refresh.
//
// Triggered by the Vercel Cron defined in vercel.json. Secured by CRON_SECRET:
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when that
// env var is set. Runs with a service-role client since there's no user
// session on a cron invocation.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { syncQbBalances } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  try {
    const db = createAdminClient();
    const { synced, total } = await syncQbBalances(db);
    return NextResponse.json({ ok: true, synced, total });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'sync failed' },
      { status: 502 },
    );
  }
}
