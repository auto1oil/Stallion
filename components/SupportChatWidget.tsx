'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

// Floating "Chat with us now" button for anonymous visitors. Routes to staff
// via /api/support/*. Hidden on staff/admin pages and inside the app's own
// messaging. Guest session persists in localStorage.

type Msg = { id: string; sender_name: string | null; from_guest: boolean; body: string; created_at: string };
const LS_KEY = 'support_chat_session';

export default function SupportChatWidget() {
  const pathname = usePathname() || '';
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<{ id: string; token: string } | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [req, setReq] = useState({ phone: false, email: false });
  const [chatOpen, setChatOpen] = useState(true);
  const [offlineMsg, setOfflineMsg] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  // Don't show on staff/admin/driver/salesman areas or the in-app messages.
  const hidden = /^\/(admin|driver|salesman|settings|tasks|reminders|messages)/.test(pathname)
    || pathname.startsWith('/shop/messages');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setSession(JSON.parse(raw));
    } catch { /* ignore */ }
    fetch('/api/support/start').then((r) => r.json()).then((j) => {
      if (j.ok) {
        setReq({ phone: j.require_phone, email: j.require_email });
        setChatOpen(j.open !== false);
        setOfflineMsg(j.offline_message || '');
      }
    }).catch(() => {});
  }, []);

  // Poll messages while open + session exists.
  useEffect(() => {
    if (!open || !session) return;
    let alive = true;
    async function load() {
      const r = await fetch(`/api/support/messages?session_id=${session!.id}&guest_token=${session!.token}`);
      const j = await r.json();
      if (alive && j.ok) setMessages(j.messages);
    }
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [open, session]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  if (hidden) return null;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/support/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Could not start chat.'); return; }
      const s = { id: j.session_id, token: j.guest_token };
      setSession(s);
      try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
    } finally { setBusy(false); }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !draft.trim()) return;
    const text = draft; setDraft('');
    await fetch('/api/support/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.id, guest_token: session.token, body: text }),
    });
    const r = await fetch(`/api/support/messages?session_id=${session.id}&guest_token=${session.token}`);
    const j = await r.json();
    if (j.ok) setMessages(j.messages);
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-50 px-4 py-3 rounded-full bg-brand-700 text-white font-semibold shadow-lg hover:bg-brand-900 flex items-center gap-2"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          Chat with us now
        </button>
      )}

      {open && (
        <div className="fixed bottom-4 right-4 z-50 w-[92vw] max-w-sm bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col" style={{ height: 'min(70vh, 520px)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-brand-700 text-white rounded-t-xl">
            <span className="font-semibold text-sm">Chat with Auto 1 Oil</span>
            <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white text-xl leading-none">×</button>
          </div>

          {!session && !chatOpen ? (
            <div className="p-4 flex-1 overflow-y-auto">
              <p className="text-sm text-gray-600">{offlineMsg || "We're offline right now. Please check back during business hours."}</p>
            </div>
          ) : !session ? (
            <form onSubmit={start} className="p-4 space-y-3 flex-1 overflow-y-auto">
              <p className="text-sm text-gray-600">Hi! Leave your name and we&apos;ll answer right here.</p>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Your name" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
              {req.phone && (
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="Phone" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
              )}
              {req.email && (
                <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="Email" className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
              )}
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button type="submit" disabled={busy}
                className="w-full py-2 bg-brand-700 text-white rounded-md font-medium hover:bg-brand-900 disabled:opacity-50">
                {busy ? 'Starting…' : 'Start chat'}
              </button>
            </form>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {messages.length === 0 && <p className="text-center text-xs text-gray-400 mt-4">Send a message and we&apos;ll reply here.</p>}
                {messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.from_guest ? 'items-end' : 'items-start'}`}>
                    {!m.from_guest && <span className="text-[10px] text-gray-500 mb-0.5">{m.sender_name || 'Auto 1 Oil'}</span>}
                    <div className={`px-3 py-2 rounded-2xl text-sm max-w-[80%] whitespace-pre-wrap break-words ${
                      m.from_guest ? 'bg-brand-700 text-white rounded-br-sm' : 'bg-gray-100 text-gray-900 rounded-bl-sm'}`}>
                      {m.body}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <form onSubmit={send} className="p-2 border-t border-gray-200 flex gap-2">
                <input value={draft} onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type a message…" className="flex-1 px-3 py-2 border border-gray-300 rounded-full text-sm" />
                <button type="submit" disabled={!draft.trim()}
                  className="px-4 py-2 bg-brand-700 text-white rounded-full text-sm font-medium hover:bg-brand-900 disabled:opacity-40">Send</button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
