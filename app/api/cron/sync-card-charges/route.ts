// GET /api/cron/sync-card-charges — nightly card-charge pull + receipt match.
// Secured by CRON_SECRET (Vercel Cron sends it automatically). No-ops
// gracefully until Plaid and the receipts API are configured.

import { NextResponse } from 'next/server';
import { syncCardCharges } from '@/lib/card-charges';

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
    const result = await syncCardCharges();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'sync failed' },
      { status: 500 },
    );
  }
}
