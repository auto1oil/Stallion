// GET /api/cron/reminders — daily check for due reminders.
//
// Triggered by the Vercel Cron in vercel.json. For each active reminder whose
// date has arrived, creates an in-app notification (which the notifications
// trigger turns into a Web Push) for the owner, then advances recurring
// reminders to their next occurrence or marks one-time ones done.
// Secured by CRON_SECRET.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type Reminder = {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
  remind_on: string;
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  notify_in_app: boolean;
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Advance a date string to the next occurrence strictly after `today`.
function nextOccurrence(remindOn: string, repeat: Reminder['repeat'], today: string): string {
  const d = new Date(remindOn + 'T00:00:00');
  const todayD = new Date(today + 'T00:00:00');
  // Step forward until we're past today (handles a reminder that was missed
  // for several periods).
  let guard = 0;
  while (d <= todayD && guard < 1000) {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (repeat === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else break;
    guard++;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Normalize a business name to match the salesman_visits log.
function normBizName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]s\b/g, '')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company)\b\.?/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Visit reminders: nudge the assigned rep once they're overdue, and alert
// admins about long-unvisited customers. Reads cadence from app_settings.
async function runVisitReminders(db: ReturnType<typeof createAdminClient>) {
  const { data: rows } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', ['visit_reminder_start', 'visit_reminder_interval', 'visit_admin_alert']);
  const s = Object.fromEntries(((rows as { key: string; value: string }[]) || []).map((r) => [r.key, Number(r.value)]));
  const start = s.visit_reminder_start || 45;
  const interval = Math.max(1, s.visit_reminder_interval || 5);
  const adminAlert = s.visit_admin_alert || 90;

  const { data: bizs } = await db
    .from('businesses')
    .select('id, name, assigned_sales_rep_id, created_at')
    .not('assigned_sales_rep_id', 'is', null);
  const { data: visits } = await db.from('salesman_visits').select('business_name, visit_at');

  const lastByName = new Map<string, string>();
  for (const v of (visits as { business_name: string | null; visit_at: string }[]) || []) {
    const k = normBizName(v.business_name || '');
    if (!k) continue;
    const cur = lastByName.get(k);
    if (!cur || v.visit_at > cur) lastByName.set(k, v.visit_at);
  }

  const now = Date.now();
  const overdue: string[] = [];
  let repNudges = 0;
  for (const b of (bizs as { id: string; name: string; assigned_sales_rep_id: string; created_at: string | null }[]) || []) {
    const ref = lastByName.get(normBizName(b.name || '')) || b.created_at;
    if (!ref) continue;
    const days = Math.floor((now - new Date(ref).getTime()) / 86_400_000);
    if (days >= start && (days - start) % interval === 0) {
      await db.from('notifications').insert({
        recipient_id: b.assigned_sales_rep_id,
        kind: 'visit_reminder',
        title: `Time to visit ${b.name}`,
        body: `It's been ${days} days since the last logged visit.`,
        link: '/salesman/businesses',
      });
      repNudges++;
    }
    if (days >= adminAlert && (days - adminAlert) % interval === 0) {
      overdue.push(b.name);
    }
  }

  if (overdue.length > 0) {
    const { data: admins } = await db.from('profiles').select('id').in('role', ['admin', 'master_admin']);
    const names = overdue.slice(0, 10).join(', ') + (overdue.length > 10 ? '…' : '');
    for (const a of (admins as { id: string }[]) || []) {
      await db.from('notifications').insert({
        recipient_id: a.id,
        kind: 'visit_admin_alert',
        title: `${overdue.length} customer${overdue.length === 1 ? '' : 's'} not visited in ${adminAlert}+ days`,
        body: names,
        link: '/salesman/businesses',
      });
    }
  }
  return { repNudges, adminAlerts: overdue.length };
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const db = createAdminClient();
  const today = todayISO();

  const { data: due } = await db
    .from('reminders')
    .select('id, user_id, title, note, remind_on, repeat, notify_in_app')
    .eq('active', true)
    .lte('remind_on', today)
    .or(`last_notified_on.is.null,last_notified_on.neq.${today}`);

  const reminders = (due as Reminder[]) || [];
  let fired = 0;

  for (const r of reminders) {
    if (r.notify_in_app) {
      await db.from('notifications').insert({
        recipient_id: r.user_id,
        kind: 'reminder',
        title: `Reminder: ${r.title}`,
        body: r.note || null,
        link: '/reminders',
      });
    }
    // Email delivery would go here once an email provider is configured.

    if (r.repeat === 'once') {
      await db.from('reminders').update({ active: false, last_notified_on: today }).eq('id', r.id);
    } else {
      await db
        .from('reminders')
        .update({ remind_on: nextOccurrence(r.remind_on, r.repeat, today), last_notified_on: today })
        .eq('id', r.id);
    }
    fired++;
  }

  const visits = await runVisitReminders(db);

  return NextResponse.json({ ok: true, fired, ...visits });
}
