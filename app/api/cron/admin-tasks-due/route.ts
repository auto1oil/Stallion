// GET /api/cron/admin-tasks-due — notify master admins of due business reminders.
//
// Secured by CRON_SECRET. Once per cycle (last_notified_on guard), when a task's
// due date has arrived/passed and it's still open, notifies every master admin
// (in-app → Web Push via the notifications trigger).

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  try {
    const db = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    const { data: tasks } = await db
      .from('admin_tasks')
      .select('id, title, due_date, last_notified_on')
      .eq('active', true)
      .lte('due_date', today);
    const due = (tasks || []) as { id: string; title: string; due_date: string; last_notified_on: string | null }[];
    // Only those we haven't notified for this cycle yet.
    const toNotify = due.filter((t) => !t.last_notified_on || t.last_notified_on < t.due_date);
    if (toNotify.length === 0) return NextResponse.json({ ok: true, notified: 0 });

    const { data: admins } = await db.from('profiles').select('id').eq('role', 'master_admin');
    const recipients = (admins || []).map((a) => a.id);
    if (recipients.length === 0) return NextResponse.json({ ok: true, notified: 0, note: 'no master admins' });

    let notified = 0;
    for (const t of toNotify) {
      const overdue = t.due_date < today;
      const rows = recipients.map((rid) => ({
        recipient_id: rid,
        kind: 'admin_task',
        title: `Reminder ${overdue ? 'overdue' : 'due'} — ${t.title}`,
        body: overdue ? 'This was due ' + t.due_date + '. Tap to mark it done.' : 'Due today. Tap to mark it done.',
        link: '/admin/reminders',
      }));
      const { error } = await db.from('notifications').insert(rows);
      if (error) continue;
      await db.from('admin_tasks').update({ last_notified_on: today }).eq('id', t.id);
      notified += rows.length;
    }
    return NextResponse.json({ ok: true, tasks: toNotify.length, notified });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
