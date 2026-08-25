'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

// The hauler's own drivers. They add them, they deactivate them, and the
// logins they create only ever reach the ticket screens.

type Driver = {
  id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  role: string;
  active: boolean;
};

export default function HaulerDriversPage() {
  const supabase = createClient();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ full_name: '', email: '', phone: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/haulers/drivers', { cache: 'no-store' });
      const json = await res.json();
      if (json.ok) setDrivers(json.drivers as Driver[]);
      else setError(json.error || 'Could not load your drivers.');
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!draft.email.trim()) { setError('Enter their email — it is how they sign in.'); return; }
    setBusy('add'); setError(''); setCreated(null); setCopied(false);
    try {
      const res = await fetch('/api/haulers/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not add the driver.'); return; }
      setCreated({ email: json.email, password: json.password });
      setDraft({ full_name: '', email: '', phone: '' });
      setAdding(false);
      refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy('');
    }
  }

  // Deactivating keeps their filed tickets — the history has to stay — but
  // takes them off the list you hand work to.
  async function setActive(d: Driver, active: boolean) {
    setBusy(d.id); setError('');
    const { error: err } = await supabase.from('profiles').update({ active }).eq('id', d.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const crew = drivers.filter((d) => d.role === 'driver');

  return (
    <div className="space-y-4">
      <Link href="/hauler" className="text-sm text-brand-700 hover:underline">← Loads</Link>

      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">Drivers</h1>
        <button
          onClick={() => { setAdding((v) => !v); setError(''); }}
          className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900"
        >
          {adding ? 'Cancel' : '+ Add driver'}
        </button>
      </div>

      <p className="text-sm text-gray-600">
        Your drivers sign in and fill out haul tickets. They don&apos;t see your
        rates, your fleet settings, or anyone else&apos;s work.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {adding && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label><span className={label}>Name</span>
              <input value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Email</span>
              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Phone</span>
              <input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className={input} />
            </label>
          </div>
          <button
            onClick={add}
            disabled={busy === 'add'}
            className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
          >
            {busy === 'add' ? 'Adding…' : 'Add driver'}
          </button>
        </div>
      )}

      {created && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm">
          <p className="font-medium text-emerald-900 mb-1">Driver added</p>
          <p className="text-emerald-900">Send them these. They pick their own password on first sign-in.</p>
          <div className="mt-2 font-mono text-xs bg-white border border-emerald-200 rounded p-2 space-y-0.5 break-all">
            <div>Email: {created.email}</div>
            <div>Temp password: {created.password}</div>
          </div>
          <p className="mt-2 text-xs text-emerald-800">
            Shown once, and stored nowhere. If it&apos;s lost they can use
            &quot;Forgot password&quot; on the sign-in page.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(`Email: ${created.email}\nTemp password: ${created.password}`);
                setCopied(true);
              }}
              className="text-xs text-brand-700 hover:underline"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => setCreated(null)} className="text-xs text-gray-500 hover:underline">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
          Your crew {crew.length > 0 && `— ${crew.filter((d) => d.active).length} active`}
        </h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : crew.length === 0 ? (
          <p className="text-sm text-gray-500">No drivers yet. Add your first one above.</p>
        ) : (
          <div className="space-y-1.5">
            {crew.map((d) => (
              <div key={d.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className={`font-medium ${d.active ? '' : 'text-gray-400'}`}>
                    {d.full_name || d.email}
                  </span>
                  <span className="text-gray-500"> · {[d.email, d.phone].filter(Boolean).join(' · ')}</span>
                  {!d.active && <span className="ml-2 text-[11px] text-gray-500">(deactivated)</span>}
                </span>
                <button
                  onClick={() => setActive(d, !d.active)}
                  disabled={busy === d.id}
                  className="text-xs text-brand-700 hover:underline disabled:opacity-50 shrink-0"
                >
                  {d.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
