// GET /api/staff/customers — customer list for salesmen + drivers.
//
// Assembled server-side with the service-role client and gated to staff so we
// can give drivers the list without opening businesses/profiles/documents RLS
// to them. Balance owed is included for sales reps + admins (they cover the
// accounts and need to know who owes); drivers only ever see a balance on an
// INACTIVE account that still owes money (a "don't win this one back" warning).
//
// Returns, per business: contact info, assigned rep, active flag, the order
// days that feed the cadence/next-order display, and which of the three
// customer documents are still missing (so a rep can upload them).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { isInactive, latestDay } from '@/lib/customer-active';

export const runtime = 'nodejs';

const ORDER_WINDOW_DAYS = 365;

type DocType = 'profile_sheet' | 'tax_exempt' | 'fein';
const DOC_LABEL: Record<DocType, string> = {
  profile_sheet: 'Customer profile',
  tax_exempt: 'TC-721 (tax-exempt)',
  fein: 'W-9',
};

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!me || !['office', 'driver', 'mechanic', 'contractor', 'admin', 'master_admin'].includes(me.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }
  // Reps/admins may see account balances; drivers may not (except the inactive
  // "still owes" warning applied below).
  const isRep = me.role === 'office' || me.role === 'admin' || me.role === 'master_admin';

  const db = createAdminClient();

  // Businesses — note: NO balance / oldest-invoice fields are selected.
  const { data: bizRows } = await db
    .from('businesses')
    .select('id, name, address, phone, assigned_sales_rep_id, active, reactivated_at, qb_balance, qb_last_purchase_date, qb_recent_invoice_dates')
    .order('name');
  const businesses = (bizRows || []) as {
    id: string; name: string; address: string | null; phone: string | null;
    assigned_sales_rep_id: string | null; active: boolean | null; reactivated_at: string | null;
    qb_balance: number | null; qb_last_purchase_date: string | null; qb_recent_invoice_dates: string[] | null;
  }[];

  // Customer profiles → owner + doc-applicability per business.
  const { data: profs } = await db
    .from('profiles')
    .select('id, business_id, is_business_owner, created_at, tax_exempt_applicable, w9_applicable')
    .eq('role', 'customer');
  const membersByBiz = new Map<string, { id: string; owner: boolean; created: string; taxApp: boolean; w9App: boolean }[]>();
  const profIdToBiz = new Map<string, string>();
  for (const p of (profs || []) as Record<string, unknown>[]) {
    const biz = p.business_id as string | null;
    if (!biz) continue;
    profIdToBiz.set(p.id as string, biz);
    const arr = membersByBiz.get(biz) || [];
    arr.push({
      id: p.id as string, owner: !!p.is_business_owner, created: (p.created_at as string) || '',
      taxApp: p.tax_exempt_applicable !== false, w9App: p.w9_applicable !== false,
    });
    membersByBiz.set(biz, arr);
  }

  // Documents held, by customer profile.
  const { data: docs } = await db.from('customer_documents').select('customer_id, doc_type');
  const docsByProf = new Map<string, Set<string>>();
  for (const d of (docs || []) as { customer_id: string; doc_type: string }[]) {
    const s = docsByProf.get(d.customer_id) || new Set<string>();
    s.add(d.doc_type);
    docsByProf.set(d.customer_id, s);
  }

  // The customer-facing store is gone, so there are no in-app orders to blend
  // in: order cadence and invoice history now come from the QuickBooks fields
  // cached on the business row (qb_recent_invoice_dates, qb_last_purchase_date).
  const appDaysByBiz = new Map<string, string[]>();
  const invoicesByBiz = new Map<string, { number: string | null; date: string | null; path: string }[]>();

  const cutoff = Date.now() - ORDER_WINDOW_DAYS * 86_400_000;
  const out = businesses.map((b) => {
    const members = membersByBiz.get(b.id) || [];
    const owner = members.find((m) => m.owner) || [...members].sort((a, c) => a.created.localeCompare(c.created))[0] || null;

    // Documents the business has across all its members.
    const have = new Set<string>();
    for (const m of members) for (const t of docsByProf.get(m.id) || []) have.add(t);

    const missing: { type: DocType; label: string }[] = [];
    if (!have.has('profile_sheet')) missing.push({ type: 'profile_sheet', label: DOC_LABEL.profile_sheet });
    if ((owner?.taxApp ?? true) && !have.has('tax_exempt')) missing.push({ type: 'tax_exempt', label: DOC_LABEL.tax_exempt });
    if ((owner?.w9App ?? true) && !have.has('fein')) missing.push({ type: 'fein', label: DOC_LABEL.fein });

    const allDays = [
      ...(b.qb_recent_invoice_dates || []).map((d) => d.slice(0, 10)),
      ...(b.qb_last_purchase_date ? [b.qb_last_purchase_date.slice(0, 10)] : []),
      ...(appDaysByBiz.get(b.id) || []),
    ].filter(Boolean);
    // Windowed list (12 months) drives the cadence boxes; the full max decides
    // inactivity so a 19-month-stale customer still shades even with no recent
    // dates in the window.
    const orderDays = Array.from(new Set(allDays))
      .filter((d) => new Date(d + 'T00:00:00').getTime() >= cutoff).sort().reverse();
    const inactive = b.active === false || isInactive(latestDay(allDays), b.reactivated_at);
    // Sales reps (and admins) see the real balance on every account they cover,
    // so they know who owes money before a visit/sale. Drivers still only get a
    // balance on INACTIVE accounts that owe — a "don't try to win this one back,
    // they still owe" warning — and never see balances on active accounts.
    const rawBal = b.qb_balance != null ? Number(b.qb_balance) : null;
    const balance = isRep
      ? rawBal
      : (inactive && rawBal != null && rawBal > 0 ? rawBal : null);

    // Recent invoices (newest first) with a stored PDF, for viewing.
    const invoices = (invoicesByBiz.get(b.id) || [])
      .sort((x, y) => (y.date || '').localeCompare(x.date || ''))
      .slice(0, 24);

    return {
      id: b.id,
      name: b.name,
      address: b.address,
      phone: b.phone,
      assigned_sales_rep_id: b.assigned_sales_rep_id,
      inactive,
      balance,
      owner_profile_id: owner?.id || null,
      missing_docs: missing,
      order_days: orderDays,
      invoices,
    };
  });

  return NextResponse.json({ ok: true, me: user.id, role: me.role, customers: out });
}
