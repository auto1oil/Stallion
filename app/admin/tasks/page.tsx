'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Staff = { id: string; full_name: string | null; email: string; role: string };

type Task = {
  id: string;
  batch_id: string;
  title: string;
  details: string | null;
  due_date: string | null;
  assignee_id: string;
  assignee_name: string | null;
  created_by_name: string | null;
  completed_at: string | null;
  created_at: string;
  send_count: number;
  viewed_at: string | null;
};

type Batch = {
  batch_id: string;
  title: string;
  details: string | null;
  due_date: string | null;
  created_by_name: string | null;
  created_at: string;
  send_count: number;
  rows: Task[];
};

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
function ordinal(n: number): string {
  return ORDINALS[n] || `${n}th`;
}

// Box color escalates with each re-send: white → yellow → orange → red →
// flashing red (5th and beyond).
function batchBoxClass(sendCount: number): string {
  if (sendCount <= 1) return 'bg-white border-gray-200';
  if (sendCount === 2) return 'bg-yellow-50 border-yellow-300';
  if (sendCount === 3) return 'bg-orange-50 border-orange-300';
  if (sendCount === 4) return 'bg-red-50 border-red-300';
  return 'bg-red-100 border-red-400 animate-pulse';
}

export default function AdminTasksPage() {
  const supabase = createClient();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ batch_id: string; title: string; details: string; due_date: string } | null>(null);

  async function load() {
    setLoading(true);
    setLoadError('');
    const { data: { user } } = await supabase.auth.getUser();
    setMeId(user?.id ?? null);
    const [staffRes, taskRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .neq('role', 'customer')
        .order('full_name'),
      supabase
        .from('tasks')
        .select('id, batch_id, title, details, due_date, assignee_id, assignee_name, created_by_name, completed_at, created_at, send_count, viewed_at')
        .order('created_at', { ascending: false }),
    ]);
    // Surface a load failure instead of silently showing an empty list — an
    // empty result and a failed query look identical to the user otherwise.
    if (taskRes.error) setLoadError(taskRes.error.message);
    setStaff((staffRes.data as Staff[]) || []);
    setTasks((taskRes.data as Task[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Tasks assigned to THIS admin — they need to acknowledge/complete their own,
  // which the management list below doesn't allow.
  const myTasks = meId ? tasks.filter((t) => t.assignee_id === meId) : [];
  async function toggleMine(t: Task) {
    const done = !t.completed_at;
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, completed_at: done ? new Date().toISOString() : null } : x)));
    await supabase.from('tasks')
      .update({ completed_at: done ? new Date().toISOString() : null, completed_by: done ? meId : null })
      .eq('id', t.id);
  }

  const allPicked = staff.length > 0 && picked.size === staff.length;
  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setPicked((prev) => (prev.size === staff.length ? new Set() : new Set(staff.map((s) => s.id))));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!title.trim()) { setError('Add a title.'); return; }
    if (picked.size === 0) { setError('Pick at least one employee.'); return; }
    setSaving(true);
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        details: details.trim() || undefined,
        due_date: dueDate || undefined,
        assignee_ids: Array.from(picked),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || 'Could not send the task.');
      return;
    }
    setTitle(''); setDetails(''); setDueDate(''); setPicked(new Set());
    load();
  }

  async function deleteBatch(b: Batch) {
    if (!confirm(`Delete task "${b.title}" for all ${b.rows.length} assignee(s)?`)) return;
    await supabase.from('tasks').delete().eq('batch_id', b.batch_id);
    load();
  }

  // Re-send: bump the count, re-notify the assignees with an escalating label.
  async function resendBatch(b: Batch) {
    setBusyBatch(b.batch_id);
    const next = (b.send_count || 1) + 1;
    await supabase.from('tasks').update({ send_count: next, viewed_at: null }).eq('batch_id', b.batch_id);
    await supabase.rpc('notify_recipients', {
      recipient_ids: b.rows.map((r) => r.assignee_id),
      p_kind: 'task',
      p_title: `${ordinal(next).charAt(0).toUpperCase()}${ordinal(next).slice(1)} request: ${b.title}`,
      p_body: b.details || (b.due_date ? `Due ${b.due_date}` : null),
      p_link: '/tasks',
    });
    setBusyBatch(null);
    load();
  }

  async function saveEdit() {
    if (!editing) return;
    const b = batches.find((x) => x.batch_id === editing.batch_id);
    if (!b) { setEditing(null); return; }
    if (!editing.title.trim()) return;
    setBusyBatch(editing.batch_id);
    const next = (b.send_count || 1) + 1;
    await supabase
      .from('tasks')
      .update({
        title: editing.title.trim(),
        details: editing.details.trim() || null,
        due_date: editing.due_date || null,
        send_count: next,
        viewed_at: null,
      })
      .eq('batch_id', editing.batch_id);
    await supabase.rpc('notify_recipients', {
      recipient_ids: b.rows.map((r) => r.assignee_id),
      p_kind: 'task',
      p_title: `Task updated (${ordinal(next)} request): ${editing.title.trim()}`,
      p_body: editing.details.trim() || null,
      p_link: '/tasks',
    });
    setBusyBatch(null);
    setEditing(null);
    load();
  }

  const batches = useMemo<Batch[]>(() => {
    const map = new Map<string, Batch>();
    for (const t of tasks) {
      let b = map.get(t.batch_id);
      if (!b) {
        b = {
          batch_id: t.batch_id,
          title: t.title,
          details: t.details,
          due_date: t.due_date,
          created_by_name: t.created_by_name,
          created_at: t.created_at,
          send_count: t.send_count || 1,
          rows: [],
        };
        map.set(t.batch_id, b);
      }
      b.rows.push(t);
    }
    return Array.from(map.values());
  }, [tasks]);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Tasks</h1>

      {/* My tasks — tasks assigned to this admin, with acknowledge/complete. */}
      {myTasks.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
          <h2 className="font-semibold mb-3">My tasks <span className="text-xs text-gray-500 font-normal">({myTasks.filter((t) => !t.completed_at).length} open)</span></h2>
          <div className="space-y-2">
            {myTasks.map((t) => (
              <label key={t.id} className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={!!t.completed_at} onChange={() => toggleMine(t)} className="w-5 h-5 mt-0.5" />
                <span className="min-w-0">
                  <span className={`font-medium ${t.completed_at ? 'line-through text-gray-400' : ''}`}>{t.title}</span>
                  {t.details && <span className="block text-sm text-gray-500">{t.details}</span>}
                  <span className="block text-xs text-gray-400">
                    {t.created_by_name ? `From ${t.created_by_name}` : ''}{t.due_date ? ` · due ${t.due_date}` : ''}
                    {t.completed_at ? ` · done ${new Date(t.completed_at).toLocaleDateString('en-US')}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Assign a task */}
      <form onSubmit={submit} className="bg-white border border-gray-200 rounded-lg p-4 mb-6 space-y-3">
        <h2 className="font-semibold">Assign a task</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="e.g. Restock truck #3" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Details <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-md" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Due date <span className="text-gray-400 font-normal">(optional)</span></label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium">Assign to</label>
            <button type="button" onClick={toggleAll} className="text-xs text-brand-700 hover:underline">
              {allPicked ? 'Clear all' : 'Select all staff'}
            </button>
          </div>
          {loading ? (
            <p className="text-sm text-gray-500">Loading staff…</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto border border-gray-100 rounded p-2">
              {staff.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => togglePick(s.id)} />
                  <span className="truncate">{s.full_name || s.email}</span>
                  <span className="text-[10px] text-gray-400 uppercase">{s.role === 'master_admin' ? 'admin' : s.role}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={saving}
          className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
          {saving ? 'Sending…' : `Send task${picked.size > 0 ? ` to ${picked.size}` : ''}`}
        </button>
      </form>

      {/* Sent tasks */}
      <h2 className="font-semibold mb-2">Sent tasks</h2>
      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-md p-3 mb-2 text-sm">
          Couldn’t load tasks — your tasks are safe, but the page can’t read them right now.
          This usually means the database is missing a recent column.
          <div className="text-xs text-red-700/80 mt-1 font-mono break-words">{loadError}</div>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : batches.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No tasks sent yet.</p>
      ) : (
        <div className="space-y-2">
          {batches.map((b) => {
            const doneCount = b.rows.filter((r) => r.completed_at).length;
            const allDone = doneCount === b.rows.length;
            const isEditing = editing?.batch_id === b.batch_id;
            return (
              <div key={b.batch_id} className={`border rounded-lg p-4 ${batchBoxClass(b.send_count)}`}>
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="Title"
                    />
                    <textarea
                      value={editing.details}
                      onChange={(e) => setEditing({ ...editing, details: e.target.value })}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="Details"
                    />
                    <input
                      type="date"
                      value={editing.due_date}
                      onChange={(e) => setEditing({ ...editing, due_date: e.target.value })}
                      className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                    <div className="flex gap-2">
                      <button onClick={saveEdit} disabled={busyBatch === b.batch_id}
                        className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50">
                        Save &amp; resend
                      </button>
                      <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                <>
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="font-medium flex items-center gap-2 flex-wrap">
                      {b.title}
                      {b.send_count > 1 && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
                          {ordinal(b.send_count)} request
                        </span>
                      )}
                    </div>
                    {b.details && <div className="text-sm text-gray-600 mt-0.5 whitespace-pre-wrap">{b.details}</div>}
                    <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-x-3">
                      {b.due_date && <span>Due {new Date(b.due_date + 'T00:00:00').toLocaleDateString('en-US')}</span>}
                      <span>Sent {new Date(b.created_at).toLocaleDateString('en-US')}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${allDone ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
                      {doneCount}/{b.rows.length} done
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={() => resendBatch(b)} disabled={busyBatch === b.batch_id}
                    className="text-xs px-2 py-1 rounded border border-brand-300 text-brand-700 hover:bg-brand-50 disabled:opacity-50 font-medium">
                    {busyBatch === b.batch_id ? 'Resending…' : 'Resend'}
                  </button>
                  <button onClick={() => setEditing({ batch_id: b.batch_id, title: b.title, details: b.details || '', due_date: b.due_date || '' })}
                    className="text-xs text-gray-600 hover:text-gray-900">
                    Edit
                  </button>
                  <button onClick={() => deleteBatch(b)} className="text-xs text-red-600 hover:text-red-800 ml-auto">Delete</button>
                </div>
                <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
                  {b.rows.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${r.completed_at ? 'bg-emerald-500' : r.viewed_at ? 'bg-blue-500' : 'bg-gray-300'}`} />
                      <span className="truncate">{r.assignee_name || 'Unknown'}</span>
                      <span className="text-xs text-gray-400">
                        {r.completed_at
                          ? `done ${new Date(r.completed_at).toLocaleDateString('en-US')}`
                          : r.viewed_at
                            ? 'viewed'
                            : 'not seen'}
                      </span>
                    </li>
                  ))}
                </ul>
                </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
