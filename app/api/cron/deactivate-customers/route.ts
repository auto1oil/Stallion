// GET /api/cron/deactivate-customers — auto-deactivate stale customers.
//
// Secured by CRON_SECRET (Vercel Cron sends it). A business is "inactive" once
// its most recent activity (in-app order, QuickBooks invoice, or a manual
// reactivation) is more than nine months old. Inactive businesses render shaded
// across admin / salesman / driver so reps can try to win them back. A new
// order (recent activity) auto-reactivates; admins can also reactivate manually
// (sets reactivated_at → a fresh nine-month grace).

import { NextResponse } from 'next/server';
import { runDeactivationPass } from '@/lib/deactivate-customers';

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
    const result = await runDeactivationPass();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'deactivate failed' },
      { status: 500 },
    );
  }
}
