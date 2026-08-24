'use client';

// Master-admin Settings: show/hide each nav tab per role. Defaults are "on"
// (a feature is visible unless a feature_flags row turns it off). Hiding a tab
// removes it from that role's menu.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { FEATURES, FEATURE_GROUP_TITLES } from '@/lib/feature-catalog';

export default function AdminSettingsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push('/login'); return; }
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'master_admin') { setAllowed(false); return; }
    setAllowed(true);
    const { data } = await supabase.from('feature_flags').select('key, enabled').eq('enabled', false);
    setDisabled(new Set(((data as { key: string }[]) || []).map((r) => r.key)));
  }, [supabase, router]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(key: string, enabled: boolean) {
    setSavingKey(key); setErr('');
    const { error } = await supabase
      .from('feature_flags')
      .upsert({ key, enabled, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) { setErr(error.message); setSavingKey(null); return; }
    setDisabled((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(key); else next.add(key);
      return next;
    });
    setSavingKey(null);
  }

  if (allowed === false) {
    return <p className="text-sm text-gray-500">Permissions are master-admin only.</p>;
  }
  if (allowed === null) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">Permissions</h1>
      <p className="text-sm text-gray-500 mb-5">
        Show or hide each tab for staff and customers. Everything is on by default; turn a switch
        off to remove that tab from that role&apos;s menu.
      </p>
      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      <div className="space-y-5">
        {FEATURE_GROUP_TITLES.map(({ group, title }) => {
          const items = FEATURES.filter((f) => f.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h2>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {items.map((f) => {
                  const on = !disabled.has(f.key);
                  return (
                    <div key={f.key} className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm">{f.label}</span>
                      <button
                        onClick={() => toggle(f.key, !on)}
                        disabled={savingKey === f.key}
                        role="switch"
                        aria-checked={on}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-green-500' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
