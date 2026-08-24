'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { getPushState, enablePush, disablePush, sendTestPush, ensureSubscribed, type PushState } from '@/lib/push-client';
import Avatar from '@/components/Avatar';
import AvatarEditor from '@/components/AvatarEditor';
import SupportChatSettings from '@/components/SupportChatSettings';
import { loadFab, saveFab, FAB_ACTIONS, type FabConfig } from '@/lib/floating-button';

type AlertMode = 'sound' | 'vibrate' | 'silent';

type Prefs = {
  new_order: boolean;
  order_status: boolean;
  new_customer: boolean;
  work_order: boolean;
  task: boolean;
};

const PREF_COL: Record<keyof Prefs, string> = {
  new_order: 'notify_on_new_order',
  order_status: 'notify_on_order_status',
  new_customer: 'notify_on_new_customer',
  work_order: 'notify_on_work_order',
  task: 'notify_on_task',
};

const PREF_LABEL: { key: keyof Prefs; title: string; desc: string }[] = [
  { key: 'new_order',     title: 'New orders',        desc: 'When a new order is placed.' },
  { key: 'order_status',  title: 'Order status',      desc: 'When an order moves to out for delivery or delivered.' },
  { key: 'new_customer',  title: 'New customers',     desc: 'When a new customer signs up and needs approval.' },
  { key: 'work_order',    title: 'Work orders',       desc: 'When a ticket is submitted, approved, or sent back.' },
  { key: 'task',          title: 'Tasks',             desc: 'When you are assigned a task.' },
];

export default function SettingsPage() {
  const supabase = createClient();
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [me, setMe] = useState<{ id: string; name: string | null; email: string | null } | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [alertMode, setAlertMode] = useState<AlertMode>('sound');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [editFile, setEditFile] = useState<File | null>(null);
  const [theme, setTheme] = useState<'light' | 'medium' | 'dark'>('light');
  // Floating shortcut button (per-device, localStorage).
  const [fab, setFab] = useState<FabConfig | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  // Manual "get the latest app" — for when the auto-update pill doesn't reach a
  // device (iOS sometimes never fires the check). Unregister the service worker,
  // wipe caches, and reload fresh; PwaRegister re-registers on the way back in.
  async function forceUpdate() {
    setUpdating(true);
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch { /* best-effort */ }
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* best-effort */ }
    // Cache-busting query so even a stale HTML cache is bypassed.
    window.location.replace(`/settings?u=${Date.now()}`);
  }

  useEffect(() => {
    fetch('/api/version', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setAppVersion(typeof j?.sha === 'string' ? j.sha : null))
      .catch(() => {});
  }, []);

  async function refreshPush() {
    // Re-subscribe if the OS dropped it (and the user didn't opt out), so this
    // screen shows the true "on" state instead of a stale "off".
    await ensureSubscribed();
    setPush(await getPushState());
  }

  useEffect(() => {
    refreshPush();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // Fetch role on its own first — a minimal query that can't be broken by a
      // missing optional column, so the Admin section never silently vanishes.
      const { data: roleRow } = await supabase
        .from('profiles').select('role').eq('id', user.id).single();
      setRole((roleRow?.role as string) ?? null);

      const { data } = await supabase
        .from('profiles')
        .select('role, full_name, email, avatar_url, message_alert_mode, notify_on_new_order, notify_on_order_status, notify_on_new_customer, notify_on_work_order, notify_on_task')
        .eq('id', user.id)
        .single();
      const p = data as (Record<string, boolean | null> & { role?: string; full_name?: string | null; email?: string | null; avatar_url?: string | null; message_alert_mode?: AlertMode }) | null;
      if (p?.role) setRole(p.role);
      setMe({ id: user.id, name: p?.full_name ?? null, email: p?.email ?? null });
      setAvatarUrl(p?.avatar_url ?? null);
      setAlertMode((p?.message_alert_mode as AlertMode) ?? 'sound');
      setPrefs({
        new_order:     p?.notify_on_new_order ?? true,
        order_status:  p?.notify_on_order_status ?? true,
        new_customer:  p?.notify_on_new_customer ?? true,
        work_order:    p?.notify_on_work_order ?? true,
        task:          p?.notify_on_task ?? true,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onEnable() {
    setBusy(true); setMsg(null);
    const err = await enablePush();
    setMsg(err || 'Phone notifications are on for this device.');
    await refreshPush();
    setBusy(false);
  }

  async function onDisable() {
    setBusy(true); setMsg(null);
    await disablePush();
    setMsg('Phone notifications are off for this device.');
    await refreshPush();
    setBusy(false);
  }

  async function onTest() {
    setBusy(true); setMsg(null);
    const err = await sendTestPush();
    setMsg(err || 'Test notification sent — check your screen.');
    setBusy(false);
  }

  async function updatePref(key: keyof Prefs, value: boolean) {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value });
    setSaved(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('profiles').update({ [PREF_COL[key]]: value }).eq('id', user.id);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function onAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (file) setEditFile(file); // open the crop/zoom editor
  }

  // Called by the editor with the cropped + resized JPEG.
  async function uploadAvatarBlob(blob: Blob) {
    if (!me) return;
    setEditFile(null);
    setAvatarBusy(true);
    try {
      // Store under the user's own uid/ prefix (matches the avatars RLS policy).
      const path = `${me.id}/avatar.jpg`;
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (upErr) { setMsg(upErr.message); return; }
      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
      // Cache-bust so the new image shows immediately.
      const url = `${pub.publicUrl}?v=${Date.now()}`;
      await supabase.from('profiles').update({ avatar_url: url }).eq('id', me.id);
      setAvatarUrl(url);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function onRemoveAvatar() {
    if (!me) return;
    setAvatarBusy(true);
    await supabase.from('profiles').update({ avatar_url: null }).eq('id', me.id);
    setAvatarUrl(null);
    setAvatarBusy(false);
  }

  async function updateAlertMode(mode: AlertMode) {
    if (!me) return;
    setAlertMode(mode);
    await supabase.from('profiles').update({ message_alert_mode: mode }).eq('id', me.id);
  }

  // Theme is a per-device preference (stored in localStorage, applied as a
  // root-level filter). The inline script in the root layout applies it on
  // first paint; here we just keep the toggle in sync and update live.
  useEffect(() => {
    try {
      const t = localStorage.getItem('theme');
      if (t === 'medium' || t === 'dark') setTheme(t);
    } catch { /* ignore */ }
  }, []);

  function applyTheme(t: 'light' | 'medium' | 'dark') {
    setTheme(t);
    try {
      if (t === 'light') {
        localStorage.removeItem('theme');
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem('theme', t);
        document.documentElement.dataset.theme = t;
      }
    } catch { /* ignore */ }
  }

  // Floating button config (per-device).
  useEffect(() => { setFab(loadFab()); }, []);
  function updateFab(patch: Partial<FabConfig>) {
    const next = { ...(fab ?? loadFab()), ...patch };
    setFab(next);
    saveFab(next);  // saveFab notifies the mounted button to refresh live
  }

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true);

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-5">Profile, messages, and notifications for this account.</p>

      {/* App version — force the latest bundle when the auto-update pill doesn't show */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">App version</h2>
        <p className="text-xs text-gray-500 mb-3">
          If the app looks out of date or a new feature is missing, tap Update now to force the latest version onto this device.
          {appVersion && appVersion !== 'dev' && (
            <span className="block mt-1 font-mono text-gray-400">Current: {appVersion.slice(0, 7)}</span>
          )}
        </p>
        <button
          onClick={forceUpdate}
          disabled={updating}
          className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-60 font-medium">
          {updating ? 'Updating…' : '🔄 Update now'}
        </button>
      </div>

      {/* Profile photo — used on messages and read-receipt bubbles */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-3">Profile photo</h2>
        <div className="flex items-center gap-4">
          <Avatar size={56} name={me?.name} email={me?.email} url={avatarUrl} seed={me?.id} />
          <div className="space-y-2">
            <label className="inline-block px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 cursor-pointer">
              {avatarBusy ? 'Uploading…' : avatarUrl ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/*" className="hidden" onChange={onAvatarPick} disabled={avatarBusy} />
            </label>
            {editFile && (
              <AvatarEditor file={editFile} onCancel={() => setEditFile(null)} onSave={uploadAvatarBlob} />
            )}
            {avatarUrl && (
              <button onClick={onRemoveAvatar} disabled={avatarBusy}
                className="ml-2 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
                Remove
              </button>
            )}
            <p className="text-xs text-gray-500">Shown next to your messages. If you don’t add one, your initials are used.</p>
          </div>
        </div>
      </div>

      {/* Appearance — light / medium / dark, saved on this device */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Appearance</h2>
        <p className="text-xs text-gray-500 mb-3">Choose how the app looks on this device.</p>
        <div className="flex gap-2 flex-wrap">
          {([
            ['light', 'Light'],
            ['medium', 'Medium'],
            ['dark', 'Dark'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => applyTheme(mode)}
              className={`px-3 py-2 text-sm rounded-md border ${
                theme === mode
                  ? 'bg-brand-700 text-white border-brand-700 font-medium'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Floating shortcut button — per-device. Appears on every screen; tap to
          run its action, long-press to drag it anywhere. */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Floating button</h2>
        <p className="text-xs text-gray-500 mb-3">
          A quick-action button on every screen. Tap it to run its action; press and
          long-hold, then drag to move it anywhere. Saved on this device.
        </p>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={!!fab?.enabled}
            onChange={(e) => updateFab({ enabled: e.target.checked })}
            className="w-4 h-4"
          />
          Show the floating button
        </label>
        {fab?.enabled && (
          <div className="space-y-3">
            <label className="block text-xs text-gray-600">
              Action
              <select
                value={fab.href}
                onChange={(e) => {
                  const a = FAB_ACTIONS.find((x) => x.href === e.target.value);
                  // Switching action resets the label to that action's default.
                  updateFab({ href: e.target.value, label: a?.label ?? fab.label });
                }}
                className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
              >
                {Object.entries(
                  FAB_ACTIONS.reduce((acc, a) => { (acc[a.group] ||= []).push(a); return acc; }, {} as Record<string, typeof FAB_ACTIONS>),
                ).map(([group, list]) => (
                  <optgroup key={group} label={group}>
                    {list.map((a) => <option key={a.href} value={a.href}>{a.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block text-xs text-gray-600">
              Button text
              <input
                value={fab.label}
                onChange={(e) => updateFab({ label: e.target.value })}
                placeholder="e.g. Log visit"
                className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              />
            </label>
            <div className="flex items-center gap-3">
              <span className="inline-flex px-3 py-1.5 rounded-full bg-green-600 text-white text-xs font-semibold shadow">
                {fab.label || 'Log Visit'}
              </span>
              <button
                type="button"
                onClick={() => updateFab({ top: null, left: null })}
                className="text-xs text-brand-700 hover:underline"
              >
                Reset position
              </button>
            </div>
            <p className="text-[11px] text-gray-400">
              It starts at the top, next to the message icon. Long-press and drag to reposition.
            </p>
          </div>
        )}
      </div>

      {/* Message alerts — how new-message pushes behave on this account */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Message alerts</h2>
        <p className="text-xs text-gray-500 mb-3">
          How new-message notifications alert you when the app is closed.
        </p>
        <div className="flex gap-2 flex-wrap">
          {([
            ['sound', 'Sound'],
            ['vibrate', 'Vibrate'],
            ['silent', 'Silent'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => updateAlertMode(mode)}
              className={`px-3 py-2 text-sm rounded-md border ${
                alertMode === mode
                  ? 'bg-brand-700 text-white border-brand-700 font-medium'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          On iPhone, the system uses your phone’s ringer/silent switch — vibrate &amp; silent here apply on Android and desktop.
        </p>
      </div>

      {/* Push on this device */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Phone notifications</h2>
        <p className="text-xs text-gray-500 mb-3">
          Get alerts that pop up on your phone, even when the app is closed.
        </p>

        {!push ? (
          <p className="text-sm text-gray-500">Checking…</p>
        ) : !push.supported ? (
          <p className="text-sm text-amber-700">
            This browser doesn’t support phone notifications.
            {' '}On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.
          </p>
        ) : !push.configured ? (
          <p className="text-sm text-amber-700">Notifications aren’t set up on the server yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className={`inline-block w-2 h-2 rounded-full ${push.subscribed && push.permission === 'granted' ? 'bg-emerald-500' : 'bg-gray-300'}`} />
              <span className="text-gray-700">
                {push.permission === 'denied'
                  ? 'Blocked in your browser settings'
                  : push.subscribed
                    ? 'On for this device'
                    : 'Off for this device'}
              </span>
            </div>

            <p className="text-xs text-gray-500">
              Turn this on for each phone or computer where you want pop-up alerts.
              {!isStandalone && ' On iPhone it only works when the app is opened from your Home Screen icon.'}
            </p>

            <div className="flex gap-2 flex-wrap">
              {push.subscribed ? (
                <button onClick={onDisable} disabled={busy}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
                  Turn off
                </button>
              ) : (
                <button onClick={onEnable} disabled={busy || push.permission === 'denied'}
                  className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
                  Turn on phone notifications
                </button>
              )}
              {push.subscribed && (
                <button onClick={onTest} disabled={busy}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
                  Send test
                </button>
              )}
            </div>
          </div>
        )}
        {msg && <p className="text-xs text-gray-600 mt-3">{msg}</p>}
      </div>

      {/* What to be notified about */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold mb-3">Notify me about</h2>
        {!prefs ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3">
            {PREF_LABEL.map(({ key, title, desc }) => (
              <label key={key} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(e) => updatePref(key, e.target.checked)}
                  className="w-4 h-4 mt-0.5"
                />
                <div>
                  <div className="font-medium">{title}</div>
                  <div className="text-xs text-gray-500">{desc}</div>
                </div>
              </label>
            ))}
            <div className="text-xs text-gray-400 pt-1">
              {saved ? 'Saved ✓' : 'Changes save automatically.'}
            </div>
          </div>
        )}
      </div>

      {(role === 'admin' || role === 'master_admin') && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mt-5">
          <h2 className="font-semibold mb-3">Admin</h2>
          <div className="space-y-2">
            <Link
              href="/admin/users"
              className="flex items-center justify-between px-3 py-2 rounded-md border border-gray-200 hover:bg-gray-50"
            >
              <span className="text-sm font-medium">Users</span>
              <span className="text-xs text-gray-400">Manage staff &amp; roles →</span>
            </Link>
            <Link
              href="/admin/quickbooks"
              className="flex items-center justify-between px-3 py-2 rounded-md border border-gray-200 hover:bg-gray-50"
            >
              <span className="text-sm font-medium">QuickBooks</span>
              <span className="text-xs text-gray-400">Connect &amp; sync →</span>
            </Link>
          </div>
        </div>
      )}

      {(role === 'admin' || role === 'master_admin') && <SupportChatSettings />}

    </div>
  );
}
