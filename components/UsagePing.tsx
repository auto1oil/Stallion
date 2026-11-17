'use client';
import { useEffect, useRef } from 'react';

// Tells the server the app is open on a screen: one quiet ping a minute
// while the tab is visible, one when it becomes visible again. No ping while
// hidden — pocket time isn't usage. The server turns these into per-day
// active time for the master admin's usage report.

const INTERVAL_MS = 60 * 1000;

export default function UsagePing() {
  const lastSent = useRef(0);

  useEffect(() => {
    function send() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      // visibilitychange + interval can stack — never ping twice in 30s.
      if (now - lastSent.current < 30 * 1000) return;
      lastSent.current = now;
      fetch('/api/usage/ping', { method: 'POST', keepalive: true }).catch(() => {
        /* a missed ping is a minute of uncounted time, nothing more */
      });
    }

    send();
    const timer = setInterval(send, INTERVAL_MS);
    document.addEventListener('visibilitychange', send);
    window.addEventListener('pageshow', send);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', send);
      window.removeEventListener('pageshow', send);
    };
  }, []);

  return null;
}
