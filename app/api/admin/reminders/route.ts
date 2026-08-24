// Reminders API (admin_tasks) — recurring business to-dos.
//
// GET  → list active reminders.
// POST → { action: 'add' | 'edit' | 'done' | 'delete', ... }
//
// Everything runs with the service-role client after verifying the caller is an
// admin (or master admin), so the admin_tasks RLS (which is master-admin only)
// can't block a regular admin from reading or saving, and any real DB error
// comes back as a clear message instead of a silent no-op.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Repeat = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
const REPEATS: Repeat[] = ['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

function nextDue(due: string, repeat: Repeat): string {
  const d = new Date(due + 'T00:00:00');
  if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'biweekly') d.setDate(d.getDate() + 14);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (repeat === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (repeat === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 }) };
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return { error: NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 }) };
  }
  return { db: createAdminClient() };
}

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const { data, error } = await gate.db!
    .from('admin_tasks')
    .select('id, title, note, due_date, repeat, last_completed_at, active')
    .eq('active', true)
    .order('due_date');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, tasks: data || [] });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const db = gate.db!;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || 'add');

  try {
    if (action === 'add' || action === 'edit') {
      const title = String(body.title || '').trim();
      if (!title) return NextResponse.json({ ok: false, error: 'Add a reminder title.' }, { status: 400 });
      const repeat: Repeat = REPEATS.includes(body.repeat) ? body.repeat : 'once';
      const due_date = String(body.due_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      const note = String(body.note || '').trim() || null;

      if (action === 'edit') {
        const id = String(body.id || '');
        if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
        const { error } = await db.from('admin_tasks').update({ title, note, due_date, repeat }).eq('id', id);
        if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      const { error } = await db.from('admin_tasks').insert({ title, note, due_date, repeat });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    const id = String(body.id || '');
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

    if (action === 'done') {
      const repeat: Repeat = REPEATS.includes(body.repeat) ? body.repeat : 'once';
      const due_date = String(body.due_date || '').slice(0, 10);
      const patch = repeat === 'once'
        ? { last_completed_at: new Date().toISOString(), active: false }
        : { last_completed_at: new Date().toISOString(), due_date: nextDue(due_date, repeat), last_notified_on: null };
      const { error } = await db.from('admin_tasks').update(patch).eq('id', id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (action === 'delete') {
      const { error } = await db.from('admin_tasks').update({ active: false }).eq('id', id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
