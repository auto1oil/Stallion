// POST /api/push/test — send a test Web Push to the current user's own
// devices. Reads the caller's own subscriptions via their session (RLS allows
// own rows), so it works without the service-role key.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { sendToSubscription, pushConfigured } from '@/lib/webpush';

export const runtime = 'nodejs';

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  if (!pushConfigured()) {
    return NextResponse.json({ ok: false, error: 'Push (VAPID) keys are not set on the server.' }, { status: 503 });
  }

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', user.id);
  if (!subs || subs.length === 0) {
    return NextResponse.json({ ok: false, error: 'No push subscription on this device — tap "Turn on" first.' }, { status: 404 });
  }

  let sent = 0;
  let lastErr = '';
  for (const s of subs) {
    try {
      await sendToSubscription(s, {
        title: 'Auto 1 Oil',
        body: 'Push notifications are working on this device. 🎉',
        url: '/settings',
        tag: 'test',
      });
      sent++;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'send failed';
    }
  }

  if (sent === 0) {
    return NextResponse.json({ ok: false, error: lastErr || 'Could not send the test push.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sent });
}
