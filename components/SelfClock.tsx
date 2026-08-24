'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Employee self clock-in/out from their phone. Grabs GPS and calls the
// server, which enforces the geofence (must be at a work site unless remote).

type Open = { id: string; clock_in_at: string; clock_in_site_id: string | null };

export default function SelfClock() {
  const supabase = createClient();
  const [open, setOpen] = useState<Open | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('time_clock')
      .select('id, clock_in_at, clock_in_site_id')
      .eq('employee_id', user.id).is('clock_out_at', null)
      .order('clock_in_at', { ascending: false }).limit(1).maybeSingle();
    const o = (data as Open) || null;
    setOpen(o);
    if (o?.clock_in_site_id) {
      const { data: s } = await supabase.from('work_sites').select('name').eq('id', o.clock_in_site_id).maybeSingle();
      setSiteName((s as { name: string } | null)?.name ?? null);
    } else setSiteName(o ? 'Remote / off-site' : null);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  function getPos(): Promise<{ lat: number; lng: number } | null> {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
      );
    });
  }

  async function toggle() {
    setBusy(true); setErr(''); setMsg('');
    const action = open ? 'out' : 'in';
    const pos = await getPos();
    if (!pos) { setErr('Turn on location access for this app to clock in/out.'); setBusy(false); return; }
    try {
      const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
      const res = await fetch('/api/time-clock/self', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, lat: pos.lat, lng: pos.lng, tz }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error || `Could not clock ${action}.`);
      else setMsg(`${action === 'in' ? 'Clocked in' : 'Clocked out'}${j.site ? ` at ${j.site}` : ''}.`);
    } catch { setErr('Network error.'); }
    await load();
    setBusy(false);
  }

  const elapsed = open ? (() => {
    const m = Math.floor((now - new Date(open.clock_in_at).getTime()) / 60_000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  })() : '';

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm">Time clock</h2>
          {open ? (
            <p className="text-xs text-gray-600">On the clock {elapsed}{siteName ? ` · ${siteName}` : ''}</p>
          ) : (
            <p className="text-xs text-gray-500">You&apos;re clocked out.</p>
          )}
        </div>
        <button onClick={toggle} disabled={busy}
          className={`px-4 py-2 text-sm rounded-full font-semibold text-white disabled:opacity-50 ${open ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>
          {busy ? '…' : open ? '● Clock out' : 'Clock in'}
        </button>
      </div>
      {msg && <p className="text-xs text-emerald-700 mt-2">{msg}</p>}
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
      <p className="text-[11px] text-gray-400 mt-2">
        Uses your phone&apos;s location — you must be at a work site to clock in/out (unless an admin set you as remote).
      </p>
    </div>
  );
}
