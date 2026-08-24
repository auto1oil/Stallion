'use client';
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Session = {
  id: string; guest_name: string | null; guest_phone: string | null; guest_email: string | null;
  status: string; created_at: string; last_at: string;
};
type Msg = { id: string; sender_name: string | null; from_guest: boolean; body: string; created_at: string };

export default function ChatLogsPage() {
  const supabase = createClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  async function loadSessions() {
    const { data } = await supabase
      .from('support_sessions')
      .select('id, guest_name, guest_phone, guest_email, status, created_at, last_at')
      .order('last_at', { ascending: false });
    setSessions((data as Session[]) || []);
    setLoading(false);
  }
  useEffect(() => {
    loadSessions();
    const t = setInterval(loadSessions, 10000);
    return () => clearInterval(t);
  }, []);

  async function loadThread(id: string) {
    const { data } = await supabase
      .from('support_messages')
      .select('id, sender_name, from_guest, body, created_at')
      .eq('session_id', id).order('created_at', { ascending: true });
    setMessages((data as Msg[]) || []);
  }
  useEffect(() => {
    if (!activeId) return;
    loadThread(activeId);
    const t = setInterval(() => loadThread(activeId), 5000);
    return () => clearInterval(t);
  }, [activeId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  async function reply(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || !draft.trim()) return;
    const text = draft; setDraft('');
    await fetch('/api/support/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: activeId, body: text }),
    });
    await loadThread(activeId);
  }
  async function closeSession() {
    if (!activeId) return;
    await fetch('/api/support/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: activeId, close: true }),
    });
    loadSessions();
  }

  const active = sessions.find((s) => s.id === activeId) || null;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Chat logs</h1>
      <p className="text-sm text-gray-500 mb-4">Questions from the public &quot;Chat with us&quot; widget. Anyone on staff can reply.</p>

      {!active ? (
        loading ? <p className="text-sm text-gray-500">Loading…</p>
        : sessions.length === 0 ? <p className="text-sm text-gray-400">No chats yet.</p>
        : (
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {sessions.map((s) => (
              <button key={s.id} onClick={() => setActiveId(s.id)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-sm font-medium">{s.guest_name || 'Visitor'}
                    {s.status === 'closed' && <span className="ml-2 text-[10px] uppercase text-gray-400">closed</span>}
                  </span>
                  <span className="block text-xs text-gray-500">
                    {[s.guest_phone, s.guest_email].filter(Boolean).join(' · ') || 'no contact info'}
                  </span>
                </span>
                <span className="text-xs text-gray-400 shrink-0">
                  {new Date(s.last_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
                  {' '}{new Date(s.last_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg flex flex-col" style={{ height: 'min(70vh, 560px)' }}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
            <button onClick={() => setActiveId(null)} className="text-sm text-brand-700 hover:underline">← Back</button>
            <span className="text-sm font-medium truncate">
              {active.guest_name || 'Visitor'}
              {(active.guest_phone || active.guest_email) && (
                <span className="text-xs text-gray-500 ml-2">{[active.guest_phone, active.guest_email].filter(Boolean).join(' · ')}</span>
              )}
            </span>
            <button onClick={closeSession} className="text-xs text-gray-500 hover:text-red-600">Close</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.from_guest ? 'items-start' : 'items-end'}`}>
                <span className="text-[10px] text-gray-500 mb-0.5">{m.from_guest ? (active.guest_name || 'Visitor') : (m.sender_name || 'You')}</span>
                <div className={`px-3 py-2 rounded-2xl text-sm max-w-[80%] whitespace-pre-wrap break-words ${
                  m.from_guest ? 'bg-gray-100 text-gray-900 rounded-bl-sm' : 'bg-brand-700 text-white rounded-br-sm'}`}>
                  {m.body}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form onSubmit={reply} className="p-2 border-t border-gray-200 flex gap-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="Reply…" className="flex-1 px-3 py-2 border border-gray-300 rounded-full text-sm" />
            <button type="submit" disabled={!draft.trim()}
              className="px-4 py-2 bg-brand-700 text-white rounded-full text-sm font-medium hover:bg-brand-900 disabled:opacity-40">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}
