'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import Avatar from '@/components/Avatar';
import MessageAttachment from '@/components/MessageAttachment';
import MediaGallery from '@/components/MediaGallery';
import {
  type Board,
  type Member,
  type Message,
  listBoards,
  listMembers,
  listMessages,
  markBoardRead,
  multiBoardEnabled,
  sendMessage,
  uploadAttachment,
} from '@/lib/messages';
import { maybeCompressImage } from '@/lib/image-compress';

type Me = { id: string; role: string; name: string | null; email: string | null };
type Person = { id: string; full_name: string | null; email: string | null; avatar_url: string | null; role: string | null; business_name: string | null };

const POLL_MS = 8_000;
const isAdmin = (role: string) => role === 'admin' || role === 'master_admin';
const isStaff = (role: string) => ['admin', 'master_admin', 'office', 'driver', 'mechanic', 'contractor', 'funder'].includes(role);

export default function MessagesView({ me }: { me: Me }) {
  const supabase = createClient();
  const search = useSearchParams();
  const [boards, setBoards] = useState<Board[]>([]);
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // board id -> member user ids, for labeling every DM in the sidebar (not
  // just the open one).
  const [boardMemberIds, setBoardMemberIds] = useState<Map<string, string[]>>(new Map());
  const [multi, setMulti] = useState(false);
  const [draft, setDraft] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const meIsAdmin = isAdmin(me.role);
  const meIsStaff = isStaff(me.role);

  // Resolve a friendly label for a board. DMs show the other party; on the
  // staff side a customer is labeled by business name.
  const boardLabel = useCallback(
    (b: Board): string => {
      if (b.kind !== 'dm') return b.name;
      // A renamed DM keeps its custom name; otherwise label by the other party.
      if (b.name && b.name !== 'Direct message') return b.name;
      const ids = boardMemberIds.get(b.id) || [];
      const otherId = ids.find((id) => id !== me.id);
      const other = otherId ? people.get(otherId) : undefined;
      if (!other) return 'Direct message';
      if (meIsStaff && other.role === 'customer') {
        return other.business_name || other.full_name || other.email || 'Customer';
      }
      return other.full_name || other.email || 'Direct message';
    },
    [boardMemberIds, people, me.id, meIsStaff],
  );

  // Load the directory of people once (names/avatars/business for labeling).
  const loadPeople = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, avatar_url, role, businesses:business_id(name)');
    type Row = { id: string; full_name: string | null; email: string | null; avatar_url: string | null; role: string | null; businesses: { name: string } | null };
    const map = new Map<string, Person>();
    ((data as unknown as Row[]) || []).forEach((r) =>
      map.set(r.id, {
        id: r.id,
        full_name: r.full_name,
        email: r.email,
        avatar_url: r.avatar_url,
        role: r.role,
        business_name: r.businesses?.name ?? null,
      }),
    );
    setPeople(map);
  }, [supabase]);

  const loadBoards = useCallback(async () => {
    const [bs, m] = await Promise.all([listBoards(), multiBoardEnabled()]);
    setMulti(m);
    // Always show conversations you're a member of (DMs + group chats are
    // member-gated by RLS). The multi-board toggle only hides extra *all-staff*
    // broadcast boards beyond the default Team board.
    const filtered = m ? bs : bs.filter((b) => b.is_default || !b.all_staff);
    setBoards(filtered);
    setActiveId((cur) => cur ?? search.get('b') ?? filtered[0]?.id ?? null);

    // Pull membership for DM boards so the sidebar can name each thread.
    const dmIds = filtered.filter((b) => b.kind === 'dm').map((b) => b.id);
    if (dmIds.length) {
      const { data } = await supabase
        .from('board_members')
        .select('board_id, user_id')
        .in('board_id', dmIds);
      const map = new Map<string, string[]>();
      ((data as { board_id: string; user_id: string }[]) || []).forEach((r) => {
        map.set(r.board_id, [...(map.get(r.board_id) || []), r.user_id]);
      });
      setBoardMemberIds(map);
    }
  }, [search, supabase]);

  useEffect(() => {
    loadPeople();
    loadBoards();
    // Re-poll the board list so chats others start with you show up live.
    const t = setInterval(loadBoards, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshActive = useCallback(async () => {
    if (!activeId) return;
    // Mark myself read FIRST so my own read row exists/updates, then load
    // members so the receipt avatars reflect the latest reads immediately.
    await markBoardRead(activeId, me.id);
    const [msgs, mem] = await Promise.all([listMessages(activeId), listMembers(activeId)]);
    setMessages(msgs);
    setMembers(mem);
  }, [activeId, me.id]);

  useEffect(() => {
    if (!activeId) return;
    refreshActive();
    const t = setInterval(refreshActive, POLL_MS);
    return () => clearInterval(t);
  }, [activeId, refreshActive]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || !draft.trim()) return;
    const body = draft;
    setDraft('');
    await sendMessage(activeId, body, me.id);
    await refreshActive();
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked || !activeId) return;
    setUploading(true);
    try {
      const file = await maybeCompressImage(picked); // downscale big photos
      const path = await uploadAttachment(activeId, file);
      await sendMessage(activeId, draft, me.id, { path, type: file.type || null, name: file.name });
      setDraft('');
      await refreshActive();
    } catch (err) {
      alert('Upload failed: ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setUploading(false);
    }
  }

  async function saveRename(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId) return;
    const n = nameDraft.trim();
    setRenaming(false);
    if (!n) return;
    await supabase.rpc('rename_board', { b: activeId, new_name: n });
    await loadBoards();
  }

  async function onDelete() {
    if (!activeBoard || activeBoard.is_default) return;
    if (!confirm('Delete this chat for everyone? This cannot be undone.')) return;
    await supabase.rpc('delete_board', { b: activeBoard.id });
    setActiveId(null);
    setShowMembers(false);
    await loadBoards();
  }

  // Read-receipt avatars for a message: members (not the sender) whose
  // last_read_at is at/after this message's time.
  const readersFor = useCallback(
    (msg: Message): Member[] =>
      members.filter(
        (mem) =>
          mem.user_id !== msg.sender_id &&
          mem.last_read_at &&
          new Date(mem.last_read_at).getTime() >= new Date(msg.created_at).getTime(),
      ),
    [members],
  );

  const activeBoard = boards.find((b) => b.id === activeId) || null;
  // A group chat: a non-default, non-all-staff board. Its members can manage
  // membership and delete it (not just admins).
  const isGroup = !!activeBoard && activeBoard.kind === 'board' && !activeBoard.all_staff && !activeBoard.is_default;

  function senderInfo(id: string | null) {
    if (!id) return { name: 'System', email: null, url: null };
    const p = people.get(id);
    return { name: p?.full_name || p?.email || 'Someone', email: p?.email ?? null, url: p?.avatar_url ?? null };
  }

  // Messenger-style: show the conversation LIST until you tap one, then show
  // only that thread with a back arrow. (No permanent split screen.)
  if (!activeBoard) {
    return (
      <div className="flex-1 min-h-0 border border-gray-200 rounded-lg overflow-hidden bg-white flex flex-col">
        {meIsStaff && (
          <NewChatPicker
            me={me}
            people={people}
            onStarted={(id) => { loadBoards(); setActiveId(id); setShowMembers(false); }}
          />
        )}
        <div className="flex-1 overflow-y-auto">
          {boards.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">No conversations yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {boards.map((b) => {
                const ids = boardMemberIds.get(b.id) || [];
                const otherId = b.kind === 'dm' ? ids.find((id) => id !== me.id) : undefined;
                const other = otherId ? people.get(otherId) : undefined;
                return (
                  <li key={b.id}>
                    <button
                      onClick={() => { setActiveId(b.id); setShowMembers(false); }}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3"
                    >
                      {b.kind === 'dm'
                        ? <Avatar size={40} name={other?.full_name} email={other?.email} url={other?.avatar_url} seed={otherId || b.id} />
                        : <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand-50 text-brand-700 font-semibold shrink-0">#</span>}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium truncate">{boardLabel(b)}</span>
                        <span className="block text-xs text-gray-400">{b.kind === 'dm' ? 'Direct message' : 'Group'}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {meIsAdmin && <MultiBoardToggle multi={multi} onChange={() => loadBoards()} />}
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <section className="flex flex-col min-w-0">
          <>
            <header className="px-3 py-2 border-b border-gray-200 bg-white flex items-center justify-between gap-2 rounded-t-lg">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => { setActiveId(null); setShowMembers(false); setRenaming(false); }}
                  aria-label="Back to conversations"
                  className="text-gray-500 hover:text-brand-700 shrink-0"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                {renaming ? (
                <form onSubmit={saveRename} className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder="Chat name…"
                    className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                  <button type="submit" className="text-xs text-brand-700 hover:underline shrink-0">Save</button>
                  <button type="button" onClick={() => setRenaming(false)} className="text-xs text-gray-400 hover:underline shrink-0">Cancel</button>
                </form>
              ) : (
                <span className="font-semibold text-sm truncate flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{boardLabel(activeBoard)}</span>
                  {(meIsAdmin || activeBoard.kind === 'dm') && (
                    <button
                      onClick={() => {
                        // Boards prefill their current name; an un-renamed DM starts blank.
                        const isPlaceholder = activeBoard.kind === 'dm' && (!activeBoard.name || activeBoard.name === 'Direct message');
                        setNameDraft(isPlaceholder ? '' : activeBoard.name);
                        setRenaming(true);
                      }}
                      aria-label="Rename chat"
                      title="Rename chat"
                      className="text-gray-400 hover:text-brand-700 shrink-0"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  )}
                </span>
                )}
              </div>
              {!renaming && (
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => setShowGallery(true)}
                    aria-label="Photos & videos"
                    title="Photos & videos"
                    className="text-gray-500 hover:text-brand-700"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                  </button>
                  {isGroup && (
                    <button onClick={() => setShowMembers((v) => !v)} className="text-xs text-brand-700 hover:underline">
                      {showMembers ? 'Hide members' : 'Members'}
                    </button>
                  )}
                  {!activeBoard.is_default && (meIsAdmin || activeBoard.kind === 'dm' || isGroup) && (
                    <button
                      onClick={onDelete}
                      aria-label="Delete chat"
                      title="Delete chat"
                      className="text-gray-400 hover:text-red-600"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </header>

            {showMembers && isGroup ? (
              <BoardMembers
                board={activeBoard}
                people={people}
                members={members}
                onChanged={refreshActive}
              />
            ) : (
              <>
                <div className="px-4 py-3 space-y-3">
                  {messages.map((m) => {
                    const s = senderInfo(m.sender_id);
                    const mine = m.sender_id === me.id;
                    const readers = readersFor(m);
                    return (
                      <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                        {!mine && <Avatar size={28} name={s.name} email={s.email} url={s.url} seed={m.sender_id || ''} />}
                        <div className={`max-w-[75%] ${mine ? 'items-end text-right' : ''} flex flex-col`}>
                          {!mine && <span className="text-[11px] text-gray-500 mb-0.5">{s.name}</span>}
                          {m.body && (
                            <div className={`inline-block px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                              mine ? 'bg-brand-700 text-white rounded-br-sm' : 'bg-gray-100 text-gray-900 rounded-bl-sm'
                            }`}>
                              {m.body}
                            </div>
                          )}
                          {m.attachment_path && (
                            <MessageAttachment path={m.attachment_path} type={m.attachment_type} name={m.attachment_name} />
                          )}
                          <div className="flex items-center gap-1 mt-0.5 justify-end">
                            <span className="text-[10px] text-gray-400">{fmtTime(m.created_at)}</span>
                            {/* Read-receipt avatars: who has read up to here. */}
                            {readers.length > 0 && (
                              <span className="flex items-center -space-x-1.5 ml-1">
                                {mine && <span className="text-[10px] text-gray-400 mr-1 self-center">Seen</span>}
                                {readers.slice(0, 5).map((r) => (
                                  <Avatar
                                    key={r.user_id}
                                    size={16}
                                    name={r.full_name}
                                    email={r.email}
                                    url={r.avatar_url}
                                    seed={r.user_id}
                                    title={`Read by ${r.full_name || r.email || 'member'}`}
                                  />
                                ))}
                                {readers.length > 5 && (
                                  <span className="text-[10px] text-gray-400 ml-1.5 self-center">+{readers.length - 5}</span>
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {messages.length === 0 && (
                    <p className="text-center text-sm text-gray-400 mt-8">No messages yet — say hello.</p>
                  )}
                  <div ref={endRef} />
                </div>

                <form onSubmit={onSend} className="border-t border-gray-200 p-2 flex gap-2 items-center sticky bottom-0 bg-white rounded-b-lg">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                    className="hidden"
                    onChange={onPickFile}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    aria-label="Attach photo, video, or file"
                    title="Attach"
                    className="shrink-0 text-gray-500 hover:text-brand-700 disabled:opacity-40 p-1"
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  <input
                    key={activeId ?? ''}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={uploading ? 'Uploading…' : 'Type a message…'}
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-full focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim() || uploading}
                    className="px-4 py-2 text-sm bg-brand-700 text-white rounded-full font-medium hover:bg-brand-900 disabled:opacity-40"
                  >
                    Send
                  </button>
                </form>
              </>
            )}
          </>
      </section>
      {showGallery && activeBoard && (
        <MediaGallery boardId={activeBoard.id} onClose={() => setShowGallery(false)} />
      )}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// --- People ordering: admins first, then drivers/salesmen, then customers;
//     alphabetical within each group. ------------------------------------------
function personLabel(p: Person): string {
  return (p.role === 'customer'
    ? p.business_name || p.full_name || p.email
    : p.full_name || p.email) || 'Unknown';
}

function roleRank(role: string | null): number {
  if (role === 'admin' || role === 'master_admin') return 0;
  if (['driver', 'mechanic', 'office', 'contractor', 'funder'].includes(role)) return 1;
  return 2; // customers (and anything else) last
}

function comparePeople(a: Person, b: Person): number {
  const r = roleRank(a.role) - roleRank(b.role);
  return r !== 0 ? r : personLabel(a).localeCompare(personLabel(b));
}

// --- New chat: pick one person (DM) or several (group), then it opens --------
function NewChatPicker({
  me,
  people,
  onStarted,
}: {
  me: Me;
  people: Map<string, Person>;
  onStarted: (boardId: string) => void;
}) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const options = useMemo(
    () => Array.from(people.values()).filter((p) => p.id !== me.id).sort(comparePeople),
    [people, me.id],
  );
  const filtered = options.filter((p) => personLabel(p).toLowerCase().includes(q.toLowerCase()));

  function toggle(id: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function reset() { setOpen(false); setSel(new Set()); setName(''); setQ(''); setErr(null); }

  async function create() {
    const ids = Array.from(sel);
    if (ids.length === 0) return;
    setErr(null);
    let boardId: string | null = null;
    if (ids.length === 1) {
      const { data, error } = await supabase.rpc('ensure_dm', { other: ids[0] });
      if (error) { setErr(error.message); return; }
      boardId = (data as string) ?? null;
    } else {
      const { data, error } = await supabase.rpc('create_group_chat', { p_name: name, member_ids: ids });
      if (error) { setErr(error.message); return; }
      boardId = (data as string) ?? null;
    }
    if (boardId) { reset(); onStarted(boardId); }
  }

  if (!open) {
    return (
      <div className="p-2 border-b border-gray-200">
        <button
          onClick={() => setOpen(true)}
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-white text-gray-700 hover:bg-gray-50 text-left"
        >
          + New chat…
        </button>
      </div>
    );
  }
  return (
    <div className="p-2 border-b border-gray-200 space-y-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Chat name (optional)"
        className="w-full px-2 py-1 text-xs border border-gray-300 rounded"
      />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people…"
        className="w-full px-2 py-1 text-xs border border-gray-300 rounded"
      />
      <ul className="max-h-48 overflow-y-auto border border-gray-100 rounded">
        {filtered.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} className="w-3.5 h-3.5" />
              <span className="truncate">{personLabel(p)}</span>
            </label>
          </li>
        ))}
        {filtered.length === 0 && <li className="px-2 py-1 text-xs text-gray-400">No match.</li>}
      </ul>
      <div className="flex gap-2">
        <button
          onClick={create}
          disabled={sel.size === 0}
          className="flex-1 px-2 py-1 text-xs bg-brand-700 text-white rounded hover:bg-brand-900 disabled:opacity-40"
        >
          {sel.size > 1 ? `Create group (${sel.size})` : 'Start chat'}
        </button>
        <button onClick={reset} className="px-2 py-1 text-xs text-gray-500 hover:underline">Cancel</button>
      </div>
      {err && <p className="text-[11px] text-red-600 break-words">{err}</p>}
    </div>
  );
}

// --- Admin: multi-board toggle ----------------------------------------------
function MultiBoardToggle({ multi, onChange }: { multi: boolean; onChange: () => void }) {
  const supabase = createClient();
  async function toggle() {
    await supabase.from('app_settings').upsert(
      { key: 'messages_multi_board', value: (!multi).toString() },
      { onConflict: 'key' },
    );
    onChange();
  }
  return (
    <div className="px-3 py-2 mt-1 border-t border-gray-200">
      <label className="flex items-center gap-2 text-[11px] text-gray-600">
        <input type="checkbox" checked={multi} onChange={toggle} className="w-3.5 h-3.5" />
        Multiple boards
      </label>
      {multi && <NewBoardButton onCreated={onChange} />}
    </div>
  );
}

function NewBoardButton({ onCreated }: { onCreated: () => void }) {
  const supabase = createClient();
  const [name, setName] = useState('');
  async function create() {
    const n = name.trim();
    if (!n) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { data } = await supabase
      .from('message_boards')
      .insert({ name: n, kind: 'board', all_staff: false, created_by: user?.id })
      .select('id')
      .single();
    // Add the creator so they can see it immediately.
    if (data?.id && user?.id) {
      await supabase.from('board_members').insert({ board_id: data.id, user_id: user.id, added_by: user.id });
    }
    setName('');
    onCreated();
  }
  return (
    <div className="flex gap-1 mt-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New board…"
        className="flex-1 px-2 py-1 text-[11px] border border-gray-300 rounded"
      />
      <button onClick={create} className="text-[11px] text-brand-700 hover:underline">add</button>
    </div>
  );
}

// --- Admin: manage members of a board ---------------------------------------
function BoardMembers({
  board,
  people,
  members,
  onChanged,
}: {
  board: Board;
  people: Map<string, Person>;
  members: Member[];
  onChanged: () => void;
}) {
  const supabase = createClient();
  const [q, setQ] = useState('');
  const memberIds = new Set(members.map((m) => m.user_id));
  // Anyone can be added to a group chat; admins first, then drivers/salesmen,
  // then customers, alphabetical within each group.
  const candidates = Array.from(people.values())
    .filter((p) => !memberIds.has(p.id))
    .sort(comparePeople);
  const filtered = candidates.filter((p) =>
    `${p.full_name || ''} ${p.email || ''} ${p.business_name || ''}`.toLowerCase().includes(q.toLowerCase()),
  );

  async function add(userId: string) {
    await supabase.rpc('add_group_member', { b: board.id, u: userId });
    onChanged();
  }
  async function remove(userId: string) {
    await supabase.rpc('remove_group_member', { b: board.id, u: userId });
    onChanged();
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Members</div>
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm min-w-0">
                <Avatar size={24} name={m.full_name} email={m.email} url={m.avatar_url} seed={m.user_id} />
                <span className="truncate">{m.full_name || m.email}</span>
              </span>
              <button onClick={() => remove(m.user_id)} className="text-xs text-red-600 hover:underline shrink-0">
                Remove
              </button>
            </li>
          ))}
          {members.length === 0 && <li className="text-xs text-gray-400">No members yet.</li>}
        </ul>
      </div>
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Add people</div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people…"
          className="w-full px-2 py-1 text-xs border border-gray-300 rounded mb-1"
        />
        <ul className="max-h-48 overflow-y-auto space-y-1">
          {filtered.slice(0, 40).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm min-w-0">
                <Avatar size={24} name={p.full_name} email={p.email} url={p.avatar_url} seed={p.id} />
                <span className="truncate">{personLabel(p)}</span>
              </span>
              <button onClick={() => add(p.id)} className="text-xs text-brand-700 hover:underline shrink-0">Add</button>
            </li>
          ))}
          {filtered.length === 0 && <li className="text-xs text-gray-400">No one to add.</li>}
        </ul>
      </div>
    </div>
  );
}
