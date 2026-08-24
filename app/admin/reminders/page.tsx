'use client';

// Master-admin business reminders: recurring tasks like sales tax, fuel-tax
// form, payroll, reconciling, statements. Each shows when it's next due; "Mark
// done" records completion and rolls the due date to the next cycle so you
// always know what's handled and what's coming. Master admins only.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type Repeat = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
type Task = {
  id: string;
  title: string;
  note: string | null;
  due_date: string;
  repeat: Repeat;
  last_completed_at: string | null;
  active: boolean;
};

const REPEAT_LABEL: Record<Repeat, string> = {
  once: 'One time', weekly: 'Weekly', biweekly: 'Every 2 weeks',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};

function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmt(iso: string) { return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

export default function AdminRemindersPage() {
  const supabase = createClient();
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState(todayISO());
  const [repeat, setRepeat] = useState<Repeat>('monthly');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Set when editing an existing reminder (the form updates it instead of adding).
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push('/login'); return; }
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') { setAllowed(false); return; }
    setAllowed(true);
    // Read through the service-role route so a regular admin (admin_tasks RLS is
    // master-admin only) still sees the rows they can save.
    try {
      const res = await fetch('/api/admin/reminders');
      const j = await res.json().catch(() => ({}));
      if (j.ok) setTasks((j.tasks as Task[]) || []);
      else setErr(j.error || 'Could not load reminders.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load reminders.');
    }
  }, [supabase, router]);
  useEffect(() => { void load(); }, [load]);

  // All writes go through the service-role API route so an RLS/session quirk in
  // the browser can never make a save silently fail — errors come back plainly.
  async function post(payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error || `Could not save (HTTP ${res.status}).`); return false; }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error.');
      return false;
    }
  }

  function resetForm() {
    setEditingId(null); setTitle(''); setNote(''); setDueDate(todayISO()); setRepeat('monthly');
  }

  function startEdit(t: Task) {
    setErr('');
    setEditingId(t.id);
    setTitle(t.title);
    setNote(t.note || '');
    setDueDate(t.due_date.slice(0, 10));
    setRepeat(t.repeat);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setErr('');
    const ok = editingId
      ? await post({ action: 'edit', id: editingId, title: title.trim(), note: note.trim() || null, due_date: dueDate, repeat })
      : await post({ action: 'add', title: title.trim(), note: note.trim() || null, due_date: dueDate, repeat });
    setBusy(false);
    if (!ok) return;
    resetForm();
    load();
  }

  async function markDone(t: Task) {
    setErr('');
    // Record completion; recurring tasks roll to the next cycle, one-time tasks
    // close out (handled server-side).
    if (await post({ action: 'done', id: t.id, repeat: t.repeat, due_date: t.due_date })) load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this reminder?')) return;
    setErr('');
    if (await post({ action: 'delete', id })) load();
  }

  if (allowed === false) return <p className="text-sm text-gray-500">Reminders are master-admin only.</p>;
  if (allowed === null) return <p className="text-sm text-gray-500">Loading…</p>;

  const today = todayISO();

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">Reminders</h1>
      <p className="text-sm text-gray-500 mb-4">
        Recurring to-dos — sales tax, fuel-tax form, payroll, reconciling, statements. You&apos;re
        notified when one comes due; mark it done and it rolls to the next cycle.
      </p>

      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      <form onSubmit={add} className={`mb-5 rounded-lg border bg-white p-3 space-y-2 ${editingId ? 'border-brand-400 ring-1 ring-brand-200' : 'border-gray-200'}`}>
        <div className="text-sm font-medium">{editingId ? 'Edit reminder' : 'Add a reminder'}</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pay sales tax"
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Details (optional) — e.g. file on the state site"
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <div className="flex gap-2 flex-wrap">
          <label className="text-xs text-gray-500 flex flex-col">Next due
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              className="border rounded px-2 py-1 text-sm" />
          </label>
          <label className="text-xs text-gray-500 flex flex-col">Repeat
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}
              className="border rounded px-2 py-1.5 text-sm bg-white">
              {(Object.keys(REPEAT_LABEL) as Repeat[]).map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy}
            className="self-end px-3 py-1.5 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50 font-medium">
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add'}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} disabled={busy}
              className="self-end px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 disabled:opacity-50">
              Cancel
            </button>
          )}
        </div>
      </form>

      {tasks.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No reminders yet.</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => {
            const days = Math.round((new Date(t.due_date + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86_400_000);
            const cls = days < 0 ? 'bg-red-100 text-red-800' : days === 0 ? 'bg-red-100 text-red-800' : days <= 7 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600';
            const label = days < 0 ? `${-days}d overdue` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `in ${days}d`;
            return (
              <div key={t.id} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{t.title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
                      <span className="text-[10px] text-gray-400">{REPEAT_LABEL[t.repeat]}</span>
                    </div>
                    {t.note && <div className="text-xs text-gray-500 mt-0.5">{t.note}</div>}
                    <div className="text-xs text-gray-400 mt-0.5">
                      Due {fmt(t.due_date)}
                      {t.last_completed_at && ` · last done ${new Date(t.last_completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => startEdit(t)}
                      className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 whitespace-nowrap hover:bg-gray-50 font-medium">
                      Edit
                    </button>
                    <button onClick={() => markDone(t)}
                      className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white whitespace-nowrap font-medium">
                      ✓ Mark done
                    </button>
                    <button onClick={() => remove(t.id)} className="text-red-600 text-xs px-1 hover:text-red-800">✕</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
