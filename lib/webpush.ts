import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

// Server-only Web Push helper. Reads subscriptions with the service-role key
// (so it can reach other users' rows past RLS) and sends notifications.

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:dispatch@auto1oil.com';

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return !!(VAPID_PUBLIC && VAPID_PRIVATE);
}

export function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  silent?: boolean;
  vibrate?: boolean;
};

// Send to one already-known subscription. Uses only web-push + VAPID — no
// Supabase access — so it works without the service-role key (used by the
// self-test, where the caller reads their own subscription via their session).
export async function sendToSubscription(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) throw new Error('Push (VAPID) keys are not configured on the server.');
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
  );
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!ensureConfigured()) return 0;
  const supa = adminClient();
  const { data: subs } = await supa
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (!subs || subs.length === 0) return 0;

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
        sent++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number })?.statusCode;
        // 404/410 mean the subscription is gone — prune it.
        if (code === 404 || code === 410) dead.push(s.id);
      }
    }),
  );
  if (dead.length) await supa.from('push_subscriptions').delete().in('id', dead);
  return sent;
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  let total = 0;
  for (const id of userIds) total += await sendPushToUser(id, payload);
  return total;
}
