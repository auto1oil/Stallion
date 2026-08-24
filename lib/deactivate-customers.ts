// Shared inactive-customer pass: a business with no in-app order / QuickBooks
// invoice activity (or manual reactivation) in 9+ months is set active=false; a
// recent order auto-reactivates it. Reused by the nightly cron and the admin
// "Run inactivity check" button.

import { createAdminClient } from '@/lib/supabase-admin';

function maxDate(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    const day = d.slice(0, 10);
    if (!best || day > best) best = day;
  }
  return best;
}

export async function runDeactivationPass(): Promise<{ total: number; deactivated: number; reactivated: number }> {
  const db = createAdminClient();

  const cut = new Date();
  cut.setMonth(cut.getMonth() - 9);
  const cutoff = cut.toISOString().slice(0, 10);

  const { data: bizRows } = await db
    .from('businesses')
    .select('id, active, reactivated_at, created_at, qb_last_purchase_date, qb_recent_invoice_dates');
  const businesses = (bizRows || []) as {
    id: string; active: boolean; reactivated_at: string | null; created_at: string;
    qb_last_purchase_date: string | null; qb_recent_invoice_dates: string[] | null;
  }[];
  if (businesses.length === 0) return { total: 0, deactivated: 0, reactivated: 0 };

  const { data: profs } = await db.from('profiles').select('id, business_id').not('business_id', 'is', null);
  const profToBiz = new Map<string, string>();
  for (const p of (profs || []) as { id: string; business_id: string }[]) profToBiz.set(p.id, p.business_id);

  // Activity is judged purely on the QuickBooks history cached on each
  // business row — there are no in-app customer orders any more.

  let deactivated = 0;
  let reactivated = 0;
  for (const b of businesses) {
    const lastActivity = maxDate([
      b.qb_last_purchase_date,
      ...(b.qb_recent_invoice_dates || []),
    ]);
    const anchor = maxDate([lastActivity, b.reactivated_at, b.created_at]);
    const shouldBeActive = !!anchor && anchor >= cutoff;

    const update: Record<string, unknown> = {};
    if (shouldBeActive !== b.active) {
      update.active = shouldBeActive;
      if (shouldBeActive) reactivated++; else deactivated++;
    }
    if (lastActivity) update.last_activity_date = lastActivity;
    if (Object.keys(update).length) await db.from('businesses').update(update).eq('id', b.id);
  }

  return { total: businesses.length, deactivated, reactivated };
}
