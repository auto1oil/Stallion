'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// How long each person actually had the app open — today, the last 7 days,
// the last 30 — built from the minute pings. Master admin only: everyone
// else renders nothing, and RLS returns them nothing anyway.

type Row = { user_id: string; day: string; seconds: number; last_ping_at: string | null };
type Person = { id: string; full_name: string | null; email: string | null; role: string };

function dayMT(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 24 * 3600 * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

function fmt(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? '<1m' : '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function UsageReport() {
  const supabase = createClient();
  const [isMaster, setIsMaster] = useState(false);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setIsMaster(data?.role === 'master_admin');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open || !isMaster) return;
    setLoading(true);
    Promise.all([
      supabase.from('usage_days').select('user_id, day, seconds, last_ping_at')
        .gte('day', dayMT(30)),
      supabase.from('profiles').select('id, full_name, email, role'),
    ]).then(([{ data: u }, { data: p }]) => {
      setRows((u as Row[]) || []);
      setPeople((p as Person[]) || []);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isMaster]);

  if (!isMaster) return null;

  const today = dayMT(0);
  const week = dayMT(7);
  const byUser = new Map<string, { today: number; week: number; month: number; last: string | null }>();
  for (const r of rows) {
    const acc = byUser.get(r.user_id) || { today: 0, week: 0, month: 0, last: null };
    acc.month += r.seconds;
    if (r.day >= week) acc.week += r.seconds;
    if (r.day === today) acc.today += r.seconds;
    if (r.last_ping_at && (!acc.last || r.last_ping_at > acc.last)) acc.last = r.last_ping_at;
    byUser.set(r.user_id, acc);
  }
  const table = people
    .map((p) => ({ p, u: byUser.get(p.id) }))
    .filter((x) => x.u)
    .sort((a, b) => (b.u!.month || 0) - (a.u!.month || 0));

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mt-5">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left flex items-center justify-between">
        <span className="font-semibold">App usage</span>
        <span className="text-xs text-brand-700">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-2">
            Time with the app actually open on a screen (counted by the
            minute, Mountain Time days). Only you see this.
          </p>
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : table.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing counted yet — time starts adding up as people use the
              app from this deploy on.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="py-1.5 font-medium">Person</th>
                  <th className="py-1.5 font-medium text-right">Today</th>
                  <th className="py-1.5 font-medium text-right">7 days</th>
                  <th className="py-1.5 font-medium text-right">30 days</th>
                  <th className="py-1.5 font-medium text-right">Last active</th>
                </tr>
              </thead>
              <tbody>
                {table.map(({ p, u }) => (
                  <tr key={p.id} className="border-b border-gray-100 last:border-0">
                    <td className="py-1.5">
                      <span className="font-medium">{p.full_name || p.email || 'Unknown'}</span>
                      <span className="text-xs text-gray-500"> · {p.role}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(u!.today)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(u!.week)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(u!.month)}</td>
                    <td className="py-1.5 text-right text-xs text-gray-500">
                      {u!.last ? new Date(u!.last).toLocaleString('en-US', {
                        timeZone: 'America/Denver', month: 'short', day: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                      }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
