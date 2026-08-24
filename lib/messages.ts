// Shared types + helpers for the message-board feature. Reads/writes go
// through the caller's Supabase session — RLS (can_access_board, is_admin)
// decides what's visible and who can manage membership.

import { createClient } from '@/lib/supabase-browser';

export type Board = {
  id: string;
  name: string;
  kind: 'board' | 'dm';
  all_staff: boolean;
  is_default: boolean;
  sort_order: number;
};

export type Message = {
  id: string;
  board_id: string;
  sender_id: string | null;
  body: string | null;
  created_at: string;
  attachment_path: string | null;
  attachment_type: string | null;
  attachment_name: string | null;
};

export type Member = {
  user_id: string;
  last_read_at: string | null;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: string | null;
};

export const MULTI_BOARD_KEY = 'messages_multi_board';

// Is multi-board mode toggled on by an admin?
export async function multiBoardEnabled(): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', MULTI_BOARD_KEY)
    .maybeSingle();
  return (data?.value ?? 'false') === 'true';
}

// All boards the current user can see, ordered for display. A board's display
// name for a DM is resolved by the caller (business name on the staff side).
export async function listBoards(): Promise<Board[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from('message_boards')
    .select('id, name, kind, all_staff, is_default, sort_order')
    .order('kind', { ascending: true }) // boards before dms
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  return (data as Board[]) || [];
}

export async function listMessages(boardId: string, limit = 200): Promise<Message[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from('messages')
    .select('id, board_id, sender_id, body, created_at, attachment_path, attachment_type, attachment_name')
    .eq('board_id', boardId)
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data as Message[]) || [];
}

// Upload a file to the board's media folder; returns its storage path.
// Throws with the underlying reason so the UI can surface it.
export async function uploadAttachment(boardId: string, file: File): Promise<string> {
  const supabase = createClient();
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${boardId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  const { error } = await supabase.storage.from('message-media').upload(path, file, {
    contentType: file.type || undefined, upsert: false,
  });
  if (error) throw new Error(error.message || 'Upload failed');
  return path;
}

// Signed URL for viewing/downloading an attachment (bucket is private).
export async function attachmentUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from('message-media').createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

// All image/video attachments on a board, newest first — for the gallery.
export async function listBoardMedia(boardId: string): Promise<Message[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from('messages')
    .select('id, board_id, sender_id, body, created_at, attachment_path, attachment_type, attachment_name')
    .eq('board_id', boardId)
    .not('attachment_path', 'is', null)
    .order('created_at', { ascending: false });
  return (data as Message[]) || [];
}

export async function listMembers(boardId: string): Promise<Member[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from('board_members')
    .select('user_id, last_read_at, profiles!inner(full_name, email, avatar_url, role)')
    .eq('board_id', boardId);
  type Row = {
    user_id: string;
    last_read_at: string | null;
    profiles: { full_name: string | null; email: string | null; avatar_url: string | null; role: string | null };
  };
  return ((data as unknown as Row[]) || []).map((r) => ({
    user_id: r.user_id,
    last_read_at: r.last_read_at,
    full_name: r.profiles?.full_name ?? null,
    email: r.profiles?.email ?? null,
    avatar_url: r.profiles?.avatar_url ?? null,
    role: r.profiles?.role ?? null,
  }));
}

export async function sendMessage(
  boardId: string,
  body: string,
  senderId: string,
  attachment?: { path: string; type: string | null; name: string | null },
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed && !attachment) return; // need text or a file
  const supabase = createClient();
  await supabase.from('messages').insert({
    board_id: boardId,
    body: trimmed || null,
    sender_id: senderId,
    attachment_path: attachment?.path ?? null,
    attachment_type: attachment?.type ?? null,
    attachment_name: attachment?.name ?? null,
  });
}

// Save the caller's read position on a board. Upserts their own member row
// (allowed for all_staff boards where no explicit row exists yet).
export async function markBoardRead(boardId: string, userId: string): Promise<void> {
  const supabase = createClient();
  await supabase
    .from('board_members')
    .upsert(
      { board_id: boardId, user_id: userId, last_read_at: new Date().toISOString() },
      { onConflict: 'board_id,user_id' },
    );
}

// Total unread across every accessible board, for the top-bar badge. Unread =
// messages from someone else newer than my last_read_at on that board.
export async function unreadCount(userId: string): Promise<number> {
  const supabase = createClient();
  const boards = await listBoards();
  if (boards.length === 0) return 0;

  const { data: myRows } = await supabase
    .from('board_members')
    .select('board_id, last_read_at')
    .eq('user_id', userId);
  const lastRead = new Map<string, string | null>(
    ((myRows as { board_id: string; last_read_at: string | null }[]) || []).map((r) => [r.board_id, r.last_read_at]),
  );

  let total = 0;
  await Promise.all(
    boards.map(async (b) => {
      let q = supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('board_id', b.id)
        .neq('sender_id', userId);
      const since = lastRead.get(b.id);
      if (since) q = q.gt('created_at', since);
      const { count } = await q;
      total += count || 0;
    }),
  );
  return total;
}

// Find-or-create a 1:1 DM with another user; returns the board id.
export async function ensureDm(otherUserId: string): Promise<string | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('ensure_dm', { other: otherUserId });
  if (error) return null;
  return data as string;
}
