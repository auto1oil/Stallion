'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Reminder = {
  id: string;
  title: string;
  note: string | null;
  remind_on: string;
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  notify_in_app: boolean;
  notify_email: boolean;
  active: boolean;
};

const REPEAT_LABEL: Record<Reminder['repeat'], string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function RemindersPage() {
  const supabase = createClient();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [remindOn, setRemindOn] = useState(todayISO());
  const [repeat, setRepeat] = useState<Reminder['repeat']>('once');
  const [inApp, setInApp] = useState(true);
  const [email, setEmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await supabase
      .from('reminders')
      .select('id, title, note, remind_on, repeat, notify_in_app, notify_email, active')
      .eq('user_id', user.id)
      .order('remind_on', { ascending: true });
    setReminders((data as Reminder[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!title.trim()) { setError('Add a reminder title.'); return; }
    if (!inApp && !email) { setError('Pick at least one way to be notified.'); return; }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }
    const { error: insErr } = await supabase.from('reminders').insert({
      user_id: user.id,
      title: title.trim(),
      note: note.trim() || null,
      remind_on: remindOn,
      repeat,
      notify_in_app: inApp,
      notify_email: email,
    });
    setSaving(false);
    if (insErr) { setError(insErr.message); return; }
    setTitle(''); setNote(''); setRemindOn(todayISO()); setRepeat('once'); setInApp(true); setEmail(false);
    load();
  }

  async function remove(id: string) {
    setReminders((prev) => prev.filter((r) => r.id !== id));
    await supabase.from('reminders').delete().eq('id', id);
  }

  const today = todayISO();

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold mb-1">Reminders</h1>
      <p className="text-sm text-gray-500 mb-5">
        Add reminders here — payroll, sales tax, ordering supplies, anything. They show up in your
        notifications and ping you when due.
      </p>

      {/* New reminder */}
      <form onSubmit={add} className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">New reminder</h2>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reminder (e.g. Run payroll)"
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
        />

        <div className="flex flex-wrap gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Remind on</label>
            <input
              type="date"
              value={remindOn}
              min={today}
              onChange={(e) => setRemindOn(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Repeat</label>
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Reminder['repeat'])}
              className="px-3 py-2 border border-gray-300 rounded-md bg-white"
            >
              {(Object.keys(REPEAT_LABEL) as Reminder['repeat'][]).map((r) => (
                <option key={r} value={r}>{REPEAT_LABEL[r]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} className="w-4 h-4" />
              In-app
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="w-4 h-4" />
              Email
            </label>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 text-sm font-semibold bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50"
          >
            {saving ? 'Adding…' : 'Add reminder'}
          </button>
        </div>
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </form>

      {/* Your reminders */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Your reminders</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : reminders.length === 0 ? (
          <p className="text-sm text-gray-500">No reminders yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {reminders.map((r) => {
              const due = r.active && r.remind_on <= today;
              return (
                <li key={r.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium flex items-center gap-2">
                      {r.title}
                      {due && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">Due</span>}
                      {!r.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">Done</span>}
                    </div>
                    {r.note && <div className="text-sm text-gray-600 mt-0.5">{r.note}</div>}
                    <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-x-3">
                      <span>{fmtDate(r.remind_on)}</span>
                      {r.repeat !== 'once' && <span>{REPEAT_LABEL[r.repeat]}</span>}
                      <span>{[r.notify_in_app && 'In-app', r.notify_email && 'Email'].filter(Boolean).join(' · ')}</span>
                    </div>
                  </div>
                  <button onClick={() => remove(r.id)} className="text-xs text-red-600 hover:text-red-800 shrink-0">
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
