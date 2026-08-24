// Inactive-customer rule, shared by the admin screen, the staff API, and the
// nightly job so everyone agrees. A business is inactive when its most recent
// order/invoice is more than nine months old — UNLESS an admin reactivated it
// within the last nine months (a fresh grace that wins over the date).
//
// All inputs are day keys (YYYY-MM-DD) or ISO strings; only the first 10 chars
// (the calendar day) are compared, which sorts lexically = chronologically.

export function nineMonthCutoff(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 9);
  return d.toISOString().slice(0, 10);
}

export function isInactive(lastActivityDay: string | null | undefined, reactivatedAt: string | null | undefined): boolean {
  const cutoff = nineMonthCutoff();
  if (reactivatedAt && reactivatedAt.slice(0, 10) >= cutoff) return false; // manual reactivation grace
  return !!lastActivityDay && lastActivityDay.slice(0, 10) < cutoff;
}

// Most recent day across a set of date-ish strings, or null.
export function latestDay(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    const day = d.slice(0, 10);
    if (!best || day > best) best = day;
  }
  return best;
}
