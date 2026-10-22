'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// The app's own sign-in record, newest first. Rows are written by the server
// on every successful login (the login_events table takes no browser writes).
// Master admin's eyes only: the panel doesn't render for anyone else, and
// RLS returns them nothing even if they query the table directly.

type LoginEvent = {
  id: string;
  email: string | null;
  at: string;
  ip: string | null;
  user_agent: string | null;
};

// "iPhone · Safari" beats a 300-character UA string in a table.
function deviceOf(ua: string | null): string {
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone')
    : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : '';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari'
    : '';
  return [os, browser].filter(Boolean).join(' · ');
}

export default function SignInHistory() {
  const supabase = createClient();
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(25);
  const [isMaster, setIsMaster] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: me } = await supabase
        .from('profiles').select('role').eq('id', user.id).single();
      setIsMaster(me?.role === 'master_admin');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open || events !== null) return;
    supabase
      .from('login_events')
      .select('id, email, at, ip, user_agent')
      .order('at', { ascending: false })
      .limit(200)
      .then(({ data }) => setEvents((data as LoginEvent[]) || []));
  }, [open, events, supabase]);

  if (!isMaster) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between text-left"
      >
        <span className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Sign-in history
        </span>
        <span className="text-xs text-brand-700">{open ? 'Hide ▾' : 'Show ▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {events === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing recorded yet — the log starts with the first sign-in after
              this feature went live.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="py-1.5 pr-4 text-left font-medium">When</th>
                      <th className="py-1.5 pr-4 text-left font-medium">Who</th>
                      <th className="py-1.5 pr-4 text-left font-medium">Device</th>
                      <th className="py-1.5 text-left font-medium">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.slice(0, shown).map((e) => (
                      <tr key={e.id} className="border-t border-gray-100">
                        <td className="py-1.5 pr-4 whitespace-nowrap tabular-nums">
                          {new Date(e.at).toLocaleString()}
                        </td>
                        <td className="py-1.5 pr-4">{e.email || '—'}</td>
                        <td className="py-1.5 pr-4 whitespace-nowrap">{deviceOf(e.user_agent) || '—'}</td>
                        <td className="py-1.5 whitespace-nowrap tabular-nums">{e.ip || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {events.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + 50)}
                  className="mt-2 text-xs text-brand-700 hover:underline"
                >
                  Show more ({events.length - shown} more loaded)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
