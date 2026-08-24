// Guest side of the support chat (scoped by guest_token; no login).
//
// GET  ?session_id=&guest_token=   → { ok, messages }
// POST { session_id, guest_token, body }
//        → posts the guest's message, bumps the session, and notifies all
//          admins/master_admins/salesmen (bell + push).

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function verify(admin: ReturnType<typeof createAdminClient>, sessionId: string, token: string) {
  const { data } = await admin.from('support_sessions')
    .select('id, guest_token, guest_name').eq('id', sessionId).maybeSingle();
  if (!data || data.guest_token !== token) return null;
  return data as { id: string; guest_token: string; guest_name: string | null };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id') || '';
  const token = url.searchParams.get('guest_token') || '';
  const admin = createAdminClient();
  if (!(await verify(admin, sessionId, token))) {
    return NextResponse.json({ ok: false, error: 'invalid session' }, { status: 403 });
  }
  const { data } = await admin.from('support_messages')
    .select('id, sender_name, from_guest, body, created_at')
    .eq('session_id', sessionId).order('created_at', { ascending: true });
  return NextResponse.json({ ok: true, messages: data || [] });
}

export async function POST(req: Request) {
  let body: { session_id?: string; guest_token?: string; body?: string };
  try { body = await req.json(); } catch { body = {}; }
  const text = (body.body || '').trim();
  if (!body.session_id || !body.guest_token || !text) {
    return NextResponse.json({ ok: false, error: 'missing fields' }, { status: 400 });
  }
  const admin = createAdminClient();
  const sess = await verify(admin, body.session_id, body.guest_token);
  if (!sess) return NextResponse.json({ ok: false, error: 'invalid session' }, { status: 403 });

  await admin.from('support_messages').insert({
    session_id: body.session_id, from_guest: true, body: text,
    sender_name: sess.guest_name || 'Visitor',
  });
  await admin.from('support_sessions').update({ last_at: new Date().toISOString(), status: 'open' }).eq('id', body.session_id);

  // Notify all staff (admins + master admins + salesmen).
  const { data: staff } = await admin.from('profiles').select('id').in('role', ['admin', 'master_admin', 'office']);
  const notes = ((staff as { id: string }[]) || []).map((s) => ({
    recipient_id: s.id,
    kind: 'support_chat',
    title: `Chat from ${sess.guest_name || 'a visitor'}`,
    body: text.slice(0, 140),
    link: '/admin/chat-logs',
  }));
  if (notes.length) await admin.from('notifications').insert(notes);

  return NextResponse.json({ ok: true });
}
