// POST   /api/push/subscribe  — save the current device's push subscription
// DELETE /api/push/subscribe  — remove it (body: { endpoint })
//
// The browser obtains a PushSubscription from the service worker and sends
// it here so the server can later push notifications to this device.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  type Body = { endpoint?: string; keys?: { p256dh?: string; auth?: string }; userAgent?: string };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ ok: false, error: 'invalid subscription' }, { status: 400 });
  }

  // Upsert on endpoint so re-subscribing the same device doesn't duplicate.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: body.userAgent || null,
      },
      { onConflict: 'endpoint' },
    );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  let body: { endpoint?: string };
  try { body = (await req.json()) as { endpoint?: string }; } catch { body = {}; }
  if (!body.endpoint) return NextResponse.json({ ok: false, error: 'endpoint required' }, { status: 400 });

  await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', body.endpoint);
  return NextResponse.json({ ok: true });
}
