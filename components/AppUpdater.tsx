'use client';

// Keeps the installed PWA from running a stale bundle. iOS keeps the app in
// memory and resumes the OLD loaded session when you reopen it, so a fresh
// deploy isn't picked up until a real reload — and a silent auto-reload doesn't
// always fire (iOS often doesn't emit a focus/visibility event on resume).
//
// So instead of reloading silently, when a newer deploy is detected we show a
// tappable "Update available" pill. The user taps it when ready (never mid-
// typing), it clears any caches and reloads into the fresh bundle. We check on
// load, whenever the app regains focus, and on a slow interval as a backstop.

import { useCallback, useEffect, useRef, useState } from 'react';

export default function AppUpdater() {
  const loadedSha = useRef<string | null>(null);
  const checking = useRef(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSha = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      const json = await res.json();
      return json?.sha ?? null;
    } catch {
      return null;
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (checking.current || updateReady) return;
    if (!loadedSha.current || document.visibilityState !== 'visible') return;
    checking.current = true;
    try {
      const sha = await fetchSha();
      if (sha && sha !== 'dev' && sha !== loadedSha.current) setUpdateReady(true);
    } finally {
      checking.current = false;
    }
  }, [fetchSha, updateReady]);

  useEffect(() => {
    let cancelled = false;
    // Record the version this session loaded with.
    fetchSha().then((sha) => { if (!cancelled) loadedSha.current = sha; });

    const onVisible = () => { if (document.visibilityState === 'visible') checkForUpdate(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkForUpdate);
    // Backstop so a long-open app still notices a deploy without a refocus.
    const timer = setInterval(checkForUpdate, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', checkForUpdate);
      clearInterval(timer);
    };
  }, [fetchSha, checkForUpdate]);

  const doUpdate = useCallback(async () => {
    setRefreshing(true);
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* clearing caches is best-effort */
    }
    // Reload from the network to pick up the new bundle.
    window.location.reload();
  }, []);

  if (!updateReady) return null;

  return (
    <div
      className="fixed inset-x-0 z-[9999] flex justify-center px-4 pointer-events-none"
      style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <button
        onClick={doUpdate}
        disabled={refreshing}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-brand-700 text-white text-sm font-semibold px-5 py-2.5 shadow-lg hover:bg-brand-900 active:scale-[0.98] transition disabled:opacity-70"
      >
        <span aria-hidden>{refreshing ? '⏳' : '🔄'}</span>
        {refreshing ? 'Updating…' : 'Update available — tap to refresh'}
      </button>
    </div>
  );
}
