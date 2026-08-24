// Browser helpers for enabling/disabling Web Push on the current device.

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
// Set on a device only when the user EXPLICITLY turns push off, so the auto
// re-subscribe below leaves it off. Cleared when they turn it back on.
const OPT_OUT_KEY = 'push_opted_out';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = {
  supported: boolean;
  configured: boolean;
  permission: NotificationPermission | 'default';
  subscribed: boolean;
};

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getPushState(): Promise<PushState> {
  const supported = pushSupported();
  const configured = !!VAPID_PUBLIC_KEY;
  if (!supported) {
    return { supported, configured, permission: 'default', subscribed: false };
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    subscribed = !!sub;
  } catch {
    /* ignore */
  }
  return { supported, configured, permission: Notification.permission, subscribed };
}

// Returns a human-readable error string on failure, or null on success.
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return 'This device/browser does not support push notifications.';
  if (!VAPID_PUBLIC_KEY) return 'Push is not configured on the server yet.';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'Notification permission was not granted.';

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
    });
  }

  const json = sub.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return j.error || 'Could not save the subscription.';
  }
  try { localStorage.removeItem(OPT_OUT_KEY); } catch { /* ignore */ }
  return null;
}

// Keep this device subscribed automatically. Runs on every app load: if the
// user already granted notification permission and hasn't explicitly turned
// push off here, re-subscribe if the browser dropped the subscription (common
// on iOS PWAs) and re-save it to the server. This makes notifications stay ON
// by default and only OFF when the user turns them off. Never prompts — a first
// grant still needs the "Turn on" tap (browsers require a user gesture).
export async function ensureSubscribed(): Promise<void> {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return;
  try {
    if (localStorage.getItem(OPT_OUT_KEY) === '1') return; // user opted out here
    if (Notification.permission !== 'granted') return;      // can't subscribe without permission
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
      });
    }
    const json = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent }),
    });
  } catch { /* best effort */ }
}

export async function disablePush(): Promise<string | null> {
  if (!pushSupported()) return null;
  // Remember the explicit opt-out so auto re-subscribe leaves it off.
  try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch { /* ignore */ }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Re-save this device's local push subscription to the server, if it has one.
// Self-heals the case where the browser is subscribed but the server row was
// lost or never persisted — without this the push trigger finds no
// subscription and the user silently stops receiving notifications while the
// UI still shows "on for this device". Idempotent (upsert on endpoint).
export async function syncSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const json = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent }),
    });
  } catch {
    /* ignore — best effort */
  }
}

export async function sendTestPush(): Promise<string | null> {
  // Self-heal first: make sure this device's current subscription is saved on
  // the server (it may have drifted/been lost), so the test has something to
  // send to. If the browser isn't subscribed at all, re-subscribe via enable.
  if (pushSupported()) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const err = await enablePush();
        if (err) return err;
      } else {
        await syncSubscription();
      }
    } catch {
      /* fall through to the request; server will report if still missing */
    }
  }
  const res = await fetch('/api/push/test', { method: 'POST' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return j.error || 'Could not send test notification.';
  }
  return null;
}
