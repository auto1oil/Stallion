// POST /api/tasks — admin assigns a task to one or more staff members.
//
// Body: { title, details?, due_date?, assignee_ids: string[] }
// Inserts one task row per assignee (sharing a batch_id). Task creation runs
// with the admin's own session (RLS allows admins to insert). In-app
// notifications + Web Push are best-effort via the service-role client, so a
// missing service-role key never blocks creating the task.

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

    const { data: me } = await supabase
      .from('profiles')
      .select('role, full_name, email')
      .eq('id', user.id)
      .single();
    if (!me || (me.role !== 'admin' && me.role !== 'master_admin')) {
      return NextResponse.json({ ok: false, error: 'admins only' }, { status: 403 });
    }

    type Body = { title?: string; details?: string; due_date?: string; assignee_ids?: string[] };
    let body: Body;
    try { body = (await req.json()) as Body; } catch { body = {}; }

    const title = body.title?.trim();
    const assigneeIds = Array.from(new Set((body.assignee_ids || []).filter(Boolean)));
    if (!title) return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 });
    if (assigneeIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'pick at least one assignee' }, { status: 400 });
    }

    // Resolve assignee display names (admins can read profiles via RLS).
    const { data: assignees, error: aErr } = await supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .in('id', assigneeIds);
    if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });
    const valid = (assignees || []).filter((a) => a.role !== 'customer');
    if (valid.length === 0) {
      return NextResponse.json({ ok: false, error: 'no valid staff assignees' }, { status: 400 });
    }

    const batchId = randomUUID();
    const createdByName = me.full_name || me.email || null;
    const due = body.due_date ? body.due_date : null;
    const details = body.details?.trim() || null;

    const taskRows = valid.map((a) => ({
      batch_id: batchId,
      title,
      details,
      due_date: due,
      assignee_id: a.id,
      assignee_name: a.full_name || a.email || null,
      created_by: user.id,
      created_by_name: createdByName,
    }));

    const { error: taskErr } = await supabase.from('tasks').insert(taskRows);
    if (taskErr) return NextResponse.json({ ok: false, error: taskErr.message }, { status: 500 });

    // In-app notifications via a security-definer RPC (no service-role key
    // needed). The notifications trigger turns each into a Web Push.
    try {
      await supabase.rpc('notify_recipients', {
        recipient_ids: valid.map((a) => a.id),
        p_kind: 'task',
        p_title: `New task: ${title}`,
        p_body: due ? `Due ${due}` : (details ? details.slice(0, 120) : null),
        p_link: '/tasks',
      });
    } catch (e) {
      console.error('task notification failed (task still created):', e);
    }

    return NextResponse.json({ ok: true, count: valid.length, batch_id: batchId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
