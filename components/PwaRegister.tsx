'use client';
import { useEffect } from 'react';
import { ensureSubscribed } from '@/lib/push-client';

// Registers the service worker once the app loads in the browser. Needed
// so the PWA is installable to home screen and the unread badge on the
// app icon works.
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js')
      // Keep this device subscribed on every load: re-subscribe if the browser
      // dropped the subscription (common on iOS) and re-save it to the server,
      // unless the user explicitly turned push off here. Notifications stay ON
      // by default and only OFF when turned off.
      .then(() => ensureSubscribed())
      .catch(() => {
        // Registration can fail in some private-browsing modes; safe to ignore.
      });
  }, []);
  return null;
}
