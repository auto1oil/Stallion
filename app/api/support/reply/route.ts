// Staff side of support chat (admin/master_admin/office).
//
// POST { session_id, body }     → posts a staff reply (shows the staff name to
//                                 the guest), bumps the session.
// POST { session_id, close:true } → marks the session closed.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role, full_name, email').eq('id', user.id).single();
  if (!me || !['admin', 'master_admin', 'office'].includes(me.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  let body: { session_id?: string; body?: string; close?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  if (!body.session_id) return NextResponse.json({ ok: false, error: 'session_id required' }, { status: 400 });

  const admin = createAdminClient();

  if (body.close) {
    await admin.from('support_sessions').update({ status: 'closed' }).eq('id', body.session_id);
    return NextResponse.json({ ok: true });
  }

  const text = (body.body || '').trim();
  if (!text) return NextResponse.json({ ok: false, error: 'empty message' }, { status: 400 });
  const senderName = (me.full_name || me.email || 'Support')!.split(/\s+/)[0];

  await admin.from('support_messages').insert({
    session_id: body.session_id, sender_id: user.id, sender_name: senderName, from_guest: false, body: text,
  });
  await admin.from('support_sessions').update({ last_at: new Date().toISOString() }).eq('id', body.session_id);
  return NextResponse.json({ ok: true });
}
