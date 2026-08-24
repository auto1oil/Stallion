// POST /api/push/dispatch — called by the notifications Postgres trigger.
//
// The trigger (which runs with full DB access) has already checked the
// recipient's preference and gathered their push subscriptions, so this
// endpoint just sends the Web Push. It does no database access — so it needs
// no service-role key. Protected by the x-push-secret header.
//
// Body: { subscriptions: [{ endpoint, p256dh, auth }], payload: {title,body,url,tag} }

import { NextResponse } from 'next/server';
import { sendToSubscription, pushConfigured, adminClient } from '@/lib/webpush';

export const runtime = 'nodejs';

type Sub = { endpoint: string; p256dh: string; auth: string };

export async function POST(req: Request) {
  const secret = process.env.PUSH_DISPATCH_SECRET;
  if (!secret || req.headers.get('x-push-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!pushConfigured()) {
    return NextResponse.json({ ok: false, error: 'push not configured' }, { status: 503 });
  }

  let body: { subscriptions?: Sub[]; payload?: { title?: string; body?: string; url?: string; tag?: string; silent?: boolean; vibrate?: boolean } };
  try { body = await req.json(); } catch { body = {}; }

  const subs = body.subscriptions || [];
  const payload = {
    title: body.payload?.title || 'Stallion',
    body: body.payload?.body || undefined,
    url: body.payload?.url || '/',
    tag: body.payload?.tag || undefined,
    silent: body.payload?.silent === true,
    vibrate: body.payload?.vibrate === true,
  };
  if (subs.length === 0) return NextResponse.json({ ok: true, sent: 0 });

  let sent = 0;
  const dead: string[] = [];
  for (const s of subs) {
    if (!s?.endpoint || !s?.p256dh || !s?.auth) continue;
    try {
      await sendToSubscription(s, payload);
      sent++;
    } catch (err: unknown) {
      // 404/410 mean the push service has permanently dropped this endpoint.
      const code = (err as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
    }
  }
  // Prune permanently-dead subscriptions so stale rows don't linger and mask
  // who is actually reachable. Best-effort; only when the service key exists.
  if (dead.length && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try { await adminClient().from('push_subscriptions').delete().in('endpoint', dead); }
    catch { /* ignore cleanup failure */ }
  }
  return NextResponse.json({ ok: true, sent });
}
