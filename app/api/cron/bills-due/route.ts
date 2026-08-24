// GET /api/cron/bills-due — daily accounts-payable due-date alerts.
//
// Secured by CRON_SECRET (Vercel Cron sends it). Each day it finds unpaid bills
// due tomorrow (day-before reminder) or today (due-date reminder) and creates
// an in-app notification for every admin + master admin — which the
// notifications trigger turns into a Web Push. A (bill, milestone) dedupe row
// in bill_due_alerts means re-runs never double-notify.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: allow when no secret configured
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const money = (n: number | null) =>
  n == null ? '' : ' ' + n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const supabase = createAdminClient();
    const now = new Date();
    const today = isoDate(now);
    const tomorrow = isoDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));

    // Unpaid, non-rejected bills coming due today or tomorrow.
    const { data: bills, error: bErr } = await supabase
      .from('vendor_bills')
      .select('id, vendor_name, total_amount, due_date')
      .eq('paid', false)
      .neq('status', 'rejected')
      .in('due_date', [today, tomorrow]);
    if (bErr) throw new Error(bErr.message);
    if (!bills || bills.length === 0) {
      return NextResponse.json({ ok: true, notified: 0, bills: 0 });
    }

    // Recipients: every admin + master admin.
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'master_admin']);
    const recipientIds = (admins || []).map((a) => a.id);
    if (recipientIds.length === 0) {
      return NextResponse.json({ ok: true, notified: 0, bills: bills.length, note: 'no admins' });
    }

    // Which (bill, milestone) alerts already went out.
    const { data: sent } = await supabase
      .from('bill_due_alerts')
      .select('bill_id, alert')
      .in('bill_id', bills.map((b) => b.id));
    const already = new Set((sent || []).map((s) => `${s.bill_id}|${s.alert}`));

    let notified = 0;
    for (const b of bills) {
      const alert = b.due_date === today ? 'due' : 'day_before';
      if (already.has(`${b.id}|${alert}`)) continue;

      const vendor = b.vendor_name || 'Vendor';
      const when = alert === 'due' ? 'due today' : 'due tomorrow';
      const title = `Bill ${when} — ${vendor}${money(b.total_amount)}`;
      const body = `${vendor} bill is ${when}. Tap to review and mark paid.`;

      const rows = recipientIds.map((rid) => ({
        recipient_id: rid,
        kind: 'bill_due',
        title,
        body,
        link: '/admin/bills',
      }));
      const { error: nErr } = await supabase.from('notifications').insert(rows);
      if (nErr) continue; // skip dedupe insert so a later run can retry

      await supabase.from('bill_due_alerts').insert({ bill_id: b.id, alert, sent_on: today });
      notified += rows.length;
    }

    return NextResponse.json({ ok: true, bills: bills.length, notified });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'bills-due failed' },
      { status: 500 },
    );
  }
}
