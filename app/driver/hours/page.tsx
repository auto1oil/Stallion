'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import TimeAdjustmentRequest from '@/components/TimeAdjustmentRequest';
import SelfClock from '@/components/SelfClock';
import { fmtClock, dayKey, todayKey, fmtDayLabel } from '@/lib/timeclock-tz';

type Entry = {
  id: string;
  date: string;
  hours: number;
  notes: string | null;
  // Time-clock roll-up (a punched day), so clocked hours show here too — not
  // just admin-side. Manual "Log hours" entries leave these undefined.
  is_clock?: boolean;
  session_count?: number;
  clock_sessions?: { in: string; out: string | null }[];
};

function getWeekRange(offset: number) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7) + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}
function fmt(d: Date) { return d.toISOString().split('T')[0]; }
function fmtNice(d: Date) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
// fmtClock + day helpers come from lib/timeclock-tz (Mountain time).
const fmtDay = fmtDayLabel;

export default function MyHoursPage() {
  const supabase = createClient();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [user, setUser] = useState<{ id: string; full_name: string | null; email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // Prior-day shifts still open (never clocked out) — not counted until an admin
  // sets the end time, so we flag rather than silently drop them.
  const [openUncounted, setOpenUncounted] = useState(0);

  async function load() {
    setLoading(true);
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) { setLoading(false); return; }
    const { data: profile } = await supabase.from('profiles').select('id, full_name, email').eq('id', authUser.id).single();
    setUser(profile as any);

    const { start, end } = getWeekRange(weekOffset);
    const endExclusive = fmt(new Date(end.getTime() + 86400000)); // day after Sunday
    const [hoursRes, clockRes] = await Promise.all([
      supabase.from('hours').select('*')
        .eq('employee_id', authUser.id)
        .gte('date', fmt(start)).lte('date', fmt(end))
        .order('date', { ascending: false }),
      // Punched time lives in time_clock, not hours — roll completed sessions
      // in so the employee sees their clocked days here (matches the admin board).
      supabase.from('time_clock')
        .select('id, clock_in_at, clock_out_at')
        .eq('employee_id', authUser.id)
        .gte('clock_in_at', fmt(start)).lt('clock_in_at', endExclusive)
        .order('clock_in_at', { ascending: true }),
    ]);

    const manual = (hoursRes.data as Entry[]) || [];

    const todayStr = todayKey();
    const byDay = new Map<string, { hours: number; count: number; sessions: { in: string; out: string | null }[] }>();
    let openPrior = 0;
    for (const s of (clockRes.data as { clock_in_at: string; clock_out_at: string | null }[]) || []) {
      const inD = new Date(s.clock_in_at);
      const dateStr = dayKey(s.clock_in_at);
      if (!s.clock_out_at) {
        // Today's open session is a shift in progress (SelfClock shows it);
        // an open session from a past day was never clocked out → uncounted.
        if (dateStr < todayStr) openPrior++;
        continue;
      }
      const outMs = new Date(s.clock_out_at).getTime();
      const inMs = inD.getTime();
      if (!(outMs > inMs)) continue;
      const cur = byDay.get(dateStr) || { hours: 0, count: 0, sessions: [] };
      cur.hours += (outMs - inMs) / 3_600_000;
      cur.count += 1;
      cur.sessions.push({ in: s.clock_in_at, out: s.clock_out_at });
      byDay.set(dateStr, cur);
    }
    const clocked: Entry[] = [];
    byDay.forEach((v, date) => {
      clocked.push({
        id: `clock-${date}`, date, hours: Math.round(v.hours * 100) / 100, notes: null,
        is_clock: true, session_count: v.count,
        clock_sessions: v.sessions.sort((a, b) => a.in.localeCompare(b.in)),
      });
    });

    const all = [...manual, ...clocked].sort((a, b) => b.date.localeCompare(a.date));
    setEntries(all);
    setOpenUncounted(openPrior);
    setLoading(false);
  }

  useEffect(() => { load(); }, [weekOffset]);

  const { start, end } = getWeekRange(weekOffset);
  const total = entries.reduce((s, e) => s + Number(e.hours), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">My hours</h1>
        <button onClick={() => setShowForm(true)} className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900">+ Log hours</button>
      </div>

      <SelfClock />
      <TimeAdjustmentRequest />

      <div className="flex items-center justify-between mb-4 bg-white border border-gray-200 rounded-lg px-3 py-2">
        <button onClick={() => setWeekOffset(weekOffset - 1)} className="px-3 py-1 text-sm hover:bg-gray-100 rounded">← Prev</button>
        <span className="text-sm font-medium">
          {fmtNice(start)} – {fmtNice(end)}{weekOffset === 0 ? ' (this week)' : ''}
        </span>
        <button onClick={() => setWeekOffset(weekOffset + 1)} className="px-3 py-1 text-sm hover:bg-gray-100 rounded">Next →</button>
      </div>

      <div className="bg-brand-50 border border-brand-500 rounded-lg p-4 mb-4 text-center">
        <div className="text-sm text-brand-900">Week total</div>
        <div className={`text-3xl font-semibold ${total > 40 ? 'text-amber-700' : 'text-brand-900'}`}>
          {total.toFixed(2)} hrs{total > 40 ? ' ⚠' : ''}
        </div>
      </div>

      {openUncounted > 0 && (
        <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          ⚠ {openUncounted} shift{openUncounted === 1 ? '' : 's'} this week {openUncounted === 1 ? 'was' : 'were'} never clocked out, so {openUncounted === 1 ? "it isn't" : "they aren't"} counted yet. Ask an admin to set the end time, or use “Request a change” below.
        </div>
      )}

      {loading ? <p className="text-sm text-gray-500">Loading…</p> : entries.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No entries yet for this week.</p>
      ) : (
        <div className="space-y-1">
          {entries.map(e => (
            <div key={e.id} className="bg-white border border-gray-200 rounded-md px-3 py-2 text-sm flex justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span>{fmtDay(e.date)}</span>
                  {e.is_clock ? (
                    <span className="text-[10px] uppercase tracking-wide bg-green-50 text-green-800 px-1.5 py-0.5 rounded">clock</span>
                  ) : e.notes ? (
                    <span className="text-gray-500">· {e.notes}</span>
                  ) : null}
                </div>
                {e.is_clock && e.clock_sessions && e.clock_sessions.length > 0 && (
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {e.clock_sessions.map((s) => `${fmtClock(s.in)} – ${fmtClock(s.out)}`).join(', ')}
                  </div>
                )}
              </div>
              <span className="font-medium shrink-0 tabular-nums">{Number(e.hours).toFixed(2)} hrs</span>
            </div>
          ))}
        </div>
      )}

      {showForm && user && (
        <DriverHoursForm user={user} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />
      )}
    </div>
  );
}

function DriverHoursForm({ user, onClose, onSaved }: {
  user: { id: string; full_name: string | null; email: string };
  onClose: () => void; onSaved: () => void;
}) {
  const supabase = createClient();
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError('');
    const { error: err } = await supabase.from('hours').insert({
      employee_id: user.id,
      employee_name: user.full_name || user.email,
      date,
      hours: parseFloat(hours),
      notes: notes || null,
    });
    if (err) { setError(err.message); setSaving(false); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <h2 className="text-lg font-semibold mb-4">Log hours</h2>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} required
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Hours</label>
              <input type="number" step="0.25" min="0" max="24" value={hours} onChange={e => setHours(e.target.value)} required
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
