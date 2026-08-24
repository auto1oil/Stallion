// POST /api/quickbooks/webhook — Intuit pushes entity-change events here.
//
// We verify the `intuit-signature` header (HMAC-SHA256 of the raw body with
// the app's Webhook Verifier Token), then for any Customer create/update we
// pull just those records from QB and upsert them into profiles — so a new
// QuickBooks customer lands in the app within seconds, no manual sync.
//
// Setup:
//   - Register this URL in the Intuit developer dashboard (Webhooks), enabling
//     the "Customer" entity.
//   - Set QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN in the app environment to the
//     token Intuit shows for the webhook.

import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase-admin';
import { syncQbCustomersByIds } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type EntityEvent = { name?: string; id?: string; operation?: string };
type Notification = { realmId?: string; dataChangeEvent?: { entities?: EntityEvent[] } };

function signatureValid(rawBody: string, header: string | null): boolean {
  const token = process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN;
  if (!token || !header) return false;
  const expected = crypto.createHmac('sha256', token).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET() {
  // Simple health check for manual verification.
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!signatureValid(rawBody, req.headers.get('intuit-signature'))) {
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
  }

  let payload: { eventNotifications?: Notification[] };
  try { payload = JSON.parse(rawBody); } catch { payload = {}; }

  const db = createAdminClient();

  // Only act on events for our connected company.
  const { data: conn } = await db
    .from('quickbooks_connection')
    .select('realm_id')
    .eq('id', 1)
    .maybeSingle();

  const customerIds = new Set<string>();
  for (const n of payload.eventNotifications || []) {
    if (conn?.realm_id && n.realmId && n.realmId !== conn.realm_id) continue;
    for (const e of n.dataChangeEvent?.entities || []) {
      const op = (e.operation || '').toLowerCase();
      if (e.name === 'Customer' && e.id && (op === 'create' || op === 'update')) {
        customerIds.add(e.id);
      }
    }
  }

  if (customerIds.size === 0) {
    // Always 200 so Intuit doesn't retry events we don't care about.
    return NextResponse.json({ ok: true, synced: 0 });
  }

  try {
    const result = await syncQbCustomersByIds(db, Array.from(customerIds));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error('QB webhook sync failed:', e);
    // Still 200 — failing here would make Intuit retry repeatedly; we log it.
    return NextResponse.json({ ok: true, error: 'sync error logged' });
  }
}
