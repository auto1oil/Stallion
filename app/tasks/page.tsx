'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Task = {
  id: string;
  title: string;
  details: string | null;
  due_date: string | null;
  created_by_name: string | null;
  completed_at: string | null;
  created_at: string;
  send_count: number;
  viewed_at: string | null;
};

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
function ordinal(n: number): string {
  return ORDINALS[n] || `${n}th`;
}

// Match the admin's escalating colors so the recipient feels the urgency.
function taskBoxClass(sendCount: number, completed: boolean): string {
  if (completed) return 'bg-white border-gray-200';
  if (sendCount <= 1) return 'bg-white border-gray-200';
  if (sendCount === 2) return 'bg-yellow-50 border-yellow-300';
  if (sendCount === 3) return 'bg-orange-50 border-orange-300';
  if (sendCount === 4) return 'bg-red-50 border-red-300';
  return 'bg-red-100 border-red-400 animate-pulse';
}

export default function MyTasksPage() {
  const supabase = createClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function load() {
    setLoading(true);
    setLoadError('');
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, details, due_date, created_by_name, completed_at, created_at, send_count, viewed_at')
      .eq('assignee_id', user.id)
      .order('completed_at', { ascending: true, nullsFirst: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) setLoadError(error.message);
    const rows = (data as Task[]) || [];
    setTasks(rows);
    setLoading(false);
    // Mark these as seen so the sender knows they've been viewed.
    const unviewed = rows.filter((t) => !t.viewed_at).map((t) => t.id);
    if (unviewed.length > 0) {
      await supabase.from('tasks').update({ viewed_at: new Date().toISOString() }).in('id', unviewed);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleComplete(t: Task) {
    const done = !t.completed_at;
    const { data: { user } } = await supabase.auth.getUser();
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, completed_at: done ? new Date().toISOString() : null } : x)));
    await supabase
      .from('tasks')
      .update({ completed_at: done ? new Date().toISOString() : null, completed_by: done ? user?.id : null })
      .eq('id', t.id);
  }

  const open = tasks.filter((t) => !t.completed_at);
  const done = tasks.filter((t) => t.completed_at);
  const shown = showDone ? done : open;

  function overdue(t: Task) {
    return t.due_date && !t.completed_at && new Date(t.due_date) < new Date(new Date().toDateString());
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4">My Tasks</h1>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-md p-3 mb-4 text-sm">
          Couldn’t load your tasks right now. Please try again in a moment.
          <div className="text-xs text-red-700/80 mt-1 font-mono break-words">{loadError}</div>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button onClick={() => setShowDone(false)}
          className={`px-3 py-1.5 text-sm rounded-md border ${!showDone ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300 hover:bg-gray-50'}`}>
          To do {open.length > 0 && <span className="text-xs text-gray-500">({open.length})</span>}
        </button>
        <button onClick={() => setShowDone(true)}
          className={`px-3 py-1.5 text-sm rounded-md border ${showDone ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300 hover:bg-gray-50'}`}>
          Completed {done.length > 0 && <span className="text-xs text-gray-500">({done.length})</span>}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">{showDone ? 'Nothing completed yet.' : 'No tasks — you’re all caught up.'}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((t) => (
            <div key={t.id} className={`border rounded-lg p-4 flex gap-3 items-start ${taskBoxClass(t.send_count, !!t.completed_at)}`}>
              <input
                type="checkbox"
                checked={!!t.completed_at}
                onChange={() => toggleComplete(t)}
                className="w-5 h-5 mt-0.5 shrink-0"
                aria-label="Mark complete"
              />
              <div className="min-w-0 flex-1">
                <div className={`font-medium flex items-center gap-2 flex-wrap ${t.completed_at ? 'line-through text-gray-400' : ''}`}>
                  {t.title}
                  {!t.completed_at && t.send_count > 1 && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-red-700">
                      {ordinal(t.send_count)} request
                    </span>
                  )}
                </div>
                {t.details && <div className="text-sm text-gray-600 mt-0.5 whitespace-pre-wrap">{t.details}</div>}
                <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-x-3">
                  {t.due_date && (
                    <span className={overdue(t) ? 'text-red-600 font-medium' : ''}>
                      Due {new Date(t.due_date + 'T00:00:00').toLocaleDateString('en-US')}
                    </span>
                  )}
                  {t.created_by_name && <span>From {t.created_by_name}</span>}
                  {t.completed_at && <span>Completed {new Date(t.completed_at).toLocaleDateString('en-US')}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
