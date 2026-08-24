'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
};

const POLL_MS = 30_000;

export default function NotificationBell({ userId }: { userId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  async function load() {
    const { data } = await supabase
      .from('notifications')
      .select('id, kind, title, body, link, created_at, read_at')
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false })
      .limit(25);
    setNotifs((data as Notif[]) || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [userId]);

  // Mirror the unread count to the OS home-screen badge when the app
  // is installed as a PWA. Quietly no-ops on browsers that don't have
  // the Badging API (most desktop browsers, older mobile).
  useEffect(() => {
    const n = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const unread = notifs.filter((x) => !x.read_at).length;
    if (unread > 0 && n.setAppBadge) {
      n.setAppBadge(unread).catch(() => {});
    } else if (unread === 0 && n.clearAppBadge) {
      n.clearAppBadge().catch(() => {});
    }
  }, [notifs]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function markAllRead() {
    const unreadIds = notifs.filter((n) => !n.read_at).map((n) => n.id);
    if (unreadIds.length === 0) return;
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', unreadIds);
    load();
  }

  async function markOneRead(n: Notif) {
    if (n.read_at) return;
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', n.id);
    setNotifs((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
  }

  async function deleteOne(id: string) {
    // Optimistic update — drop locally first so the click feels instant.
    setNotifs((prev) => prev.filter((x) => x.id !== id));
    await supabase.from('notifications').delete().eq('id', id);
  }

  async function clearAll() {
    if (notifs.length === 0) return;
    if (!confirm('Clear all notifications? This cannot be undone.')) return;
    const ids = notifs.map((n) => n.id);
    setNotifs([]);
    setOpen(false);
    await supabase.from('notifications').delete().in('id', ids);
  }

  const unread = notifs.filter((n) => !n.read_at).length;

  function fmtRelative(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative text-gray-600 hover:text-brand-700 focus:outline-none"
        aria-label={`Notifications (${unread} unread)`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold bg-accent-500 text-white rounded-full">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed right-2 top-16 w-80 max-w-[calc(100vw-1rem)] bg-white text-gray-900 rounded-lg shadow-lg border border-gray-200 z-50">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between gap-2">
            <span className="font-semibold text-sm">Notifications</span>
            <div className="flex gap-3">
              {unread > 0 && (
                <button onClick={markAllRead} className="text-xs text-brand-700 hover:underline">
                  Mark all read
                </button>
              )}
              {notifs.length > 0 && (
                <button onClick={clearAll} className="text-xs text-red-600 hover:underline">
                  Clear all
                </button>
              )}
            </div>
          </div>
          {notifs.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No notifications yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-gray-100">
              {notifs.map((n) => {
                const content = (
                  <div className={`px-3 py-2 hover:bg-gray-50 ${!n.read_at ? 'bg-brand-50/40' : ''}`}>
                    <div className="flex justify-between items-start gap-2">
                      <span className="font-medium text-sm">{n.title}</span>
                      <span className="text-[10px] text-gray-500 whitespace-nowrap shrink-0">
                        {fmtRelative(n.created_at)}
                      </span>
                    </div>
                    {n.body && <div className="text-xs text-gray-600 mt-0.5">{n.body}</div>}
                  </div>
                );
                return (
                  <li key={n.id} className="relative group">
                    {n.link ? (
                      <a
                        href={n.link}
                        onClick={async (e) => {
                          // Mark read first, then navigate, so the read state
                          // is saved before the page changes.
                          e.preventDefault();
                          await markOneRead(n);
                          setOpen(false);
                          router.push(n.link!);
                        }}
                      >
                        {content}
                      </a>
                    ) : (
                      <button
                        onClick={() => markOneRead(n)}
                        className="w-full text-left"
                      >
                        {content}
                      </button>
                    )}
                    {/* Delete button — visible on hover (desktop) and always on touch. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); deleteOne(n.id); }}
                      aria-label="Delete notification"
                      className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
