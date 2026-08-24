'use client';
import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Silently reports the employee's GPS while they're clocked in AND have the app
// open in the foreground. Mounted app-wide (root layout). It only reads GPS for
// users who currently have an open time-clock session, so nobody else is ever
// prompted for location or recorded.
//
// Foreground-only by nature: mobile browsers suspend JS (and geolocation) once
// the phone locks or the app is backgrounded, so the resulting trail has gaps
// whenever the app isn't open. This is a visibility aid, not tamper-proof
// tracking — that would need a native app with "Always Allow" location.

const PING_INTERVAL_MS = 90_000;

export default function LocationReporter() {
  const busy = useRef(false);

  useEffect(() => {
    // Create the browser client inside the effect so it never runs during SSR /
    // static prerender (where the public Supabase env vars may be absent).
    const supabase = createClient();
    let stopped = false;

    async function tick() {
      if (stopped || busy.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
      busy.current = true;
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        // Cheap indexed check — only ping GPS if they're actually on the clock.
        const { data: open } = await supabase.from('time_clock')
          .select('id').eq('employee_id', user.id).is('clock_out_at', null).limit(1).maybeSingle();
        if (!open) return;
        const pos = await new Promise<GeolocationPosition | null>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve(p),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
          );
        });
        if (!pos || stopped) return;
        await fetch('/api/time-clock/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        }).catch(() => {});
      } finally {
        busy.current = false;
      }
    }

    // Report on open, whenever the tab regains focus, and on a steady interval.
    void tick();
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVis);
    const timer = setInterval(tick, PING_INTERVAL_MS);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
