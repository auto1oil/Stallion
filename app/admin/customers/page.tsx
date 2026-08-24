'use client';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { isInactive, latestDay } from '@/lib/customer-active';
import CustomerDocuments from '@/components/CustomerDocuments';
import AdminSubNav from '@/components/AdminSubNav';
import BillingNotesBox from '@/components/BillingNotesBox';

const COUNTIES = ['Utah County', 'Salt Lake County', 'Davis County', 'Weber County'] as const;

type Customer = {
  id: string;
  email: string;
  full_name: string | null;
  business_name: string | null;
  phone: string | null;
  address: string | null;
  county: string | null;
  created_at: string;
  tax_exempt_applicable: boolean;
  w9_applicable: boolean;
  // Joined from businesses via profiles.business_id. Multiple profiles
  // may share a business; the business row holds the QB-level info
  // (balance, oldest open invoice, assigned rep, payment terms).
  business_id: string | null;
  business: {
    id: string;
    name: string;
    address: string | null;
    assigned_sales_rep_id: string | null;
    qb_balance: number | null;
    qb_oldest_open_invoice_date: string | null;
    qb_last_purchase_date: string | null;
    qb_recent_invoice_dates: string[] | null;
    qb_balance_synced_at: string | null;
    qb_payment_method: string | null;
    qb_payment_terms: string | null;
    billing_notes: string | null;
    active: boolean | null;
    last_activity_date: string | null;
    reactivated_at: string | null;
    // Set on a location (QB sub-customer) → the parent business it groups under.
    parent_business_id: string | null;
  } | null;
};

// Map QB payment-method/term values to a short label + color so admins
// can scan the list and know at a glance whether to charge the card,
// look for the driver's check, or mail an invoice.
function termsBadge(method: string | null, terms: string | null): { label: string; tone: 'green' | 'blue' | 'amber' | 'gray' } | null {
  const m = (method || '').toLowerCase();
  const t = (terms || '').toLowerCase();
  // Net terms always win — we email/mail the invoice.
  const netMatch = (terms || '').match(/net\s*(\d+)/i);
  if (netMatch) {
    return { label: `NET${netMatch[1]}`, tone: 'amber' };
  }
  if (m.includes('credit') || m.includes('card')) {
    return { label: 'Credit Card', tone: 'green' };
  }
  if (m.includes('check')) {
    // No NET term + check usually means due on delivery.
    return { label: 'Check on Delivery', tone: 'blue' };
  }
  if (t.includes('receipt') || t.includes('due')) {
    return { label: 'Due on Receipt', tone: 'blue' };
  }
  if (method) return { label: method, tone: 'gray' };
  if (terms)  return { label: terms,  tone: 'gray' };
  return null;
}

function tonalClass(tone: 'green' | 'blue' | 'amber' | 'gray'): string {
  switch (tone) {
    case 'green': return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'blue':  return 'bg-blue-50 text-blue-800 border-blue-200';
    case 'amber': return 'bg-amber-50 text-amber-800 border-amber-200';
    default:      return 'bg-gray-50 text-gray-700 border-gray-200';
  }
}

// Normalize a business name for matching duplicate customer records
// (case-insensitive, strip possessive + common suffixes + punctuation).
function normBizName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]s\b/g, '')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company)\b\.?/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Order cadence + past orders ──────────────────────────────────────────────
// How often does this customer order, and when do we expect the next one? We
// merge their in-app orders with their recent QuickBooks invoice dates, dedupe
// to unique calendar days (an app order that became a QB invoice is one event),
// keep a rolling 12-month window, and average the gaps. countdownDays < 0 =
// overdue, 0..DUE_SOON_DAYS = the rep should check in now. The same `days`
// list feeds the two-column "Past Orders" panel in the expanded card.
const ORDER_WINDOW_DAYS = 365; // rolling 12 months
const DUE_SOON_DAYS = 2;
type OrderCadence = {
  avgDays: number;        // average gap between orders, in days
  countdownDays: number;  // days until the expected next order (negative = overdue)
  expectedNext: Date;
  days: string[];         // order days in the last 12 months, YYYY-MM-DD, newest first
};
function orderCadence(rawDates: (string | null | undefined)[]): OrderCadence | null {
  // Both timestamptz (in-app) and date (QB) start YYYY-MM-DD, so slice(0,10)
  // gives a comparable day key; unique + lexical sort = chronological. Rolling
  // window so it self-adjusts as time passes.
  const cutoff = Date.now() - ORDER_WINDOW_DAYS * 86_400_000;
  const days = Array.from(new Set(rawDates.filter(Boolean).map((d) => (d as string).slice(0, 10))))
    .filter((d) => new Date(d + 'T00:00:00').getTime() >= cutoff)
    .sort()
    .reverse();
  if (days.length < 2) return null; // need at least two orders to know a cadence
  const newest = new Date(days[0] + 'T00:00:00').getTime();
  const oldest = new Date(days[days.length - 1] + 'T00:00:00').getTime();
  const avgMs = (newest - oldest) / (days.length - 1);
  const avgDays = Math.max(1, Math.round(avgMs / 86_400_000));
  const expectedNext = new Date(newest + avgMs);
  const countdownDays = Math.round((expectedNext.getTime() - Date.now()) / 86_400_000);
  return { avgDays, countdownDays, expectedNext, days };
}
// Countdown-box color: red = overdue, amber = due within a couple days (rep
// should check in), green = on schedule.
function cadenceClass(countdownDays: number): string {
  if (countdownDays < 0) return 'bg-red-50 text-red-700 border-red-200';
  if (countdownDays <= DUE_SOON_DAYS) return 'bg-amber-50 text-amber-800 border-amber-200';
  return 'bg-green-50 text-green-700 border-green-200';
}
function fmtDay(ymd: string): string {
  return new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

type InvoiceRow = { id: string; docNumber: string | null; txnDate: string | null; total: number; balance: number };

// Per-customer invoice archive. Lists the customer's QuickBooks invoices and
// links each to its PDF (streamed live from QB, which keeps invoices forever, so
// any past invoice can be pulled up and saved later). Only mounts when the
// customer card is expanded, so it fetches once on open rather than for every
// card. A timeout + Retry guarantees it never hangs on the loading placeholder.
function CustomerInvoices({ businessId }: { businessId: string | null }) {
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!businessId) { setRows([]); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    (async () => {
      setLoading(true); setErr(''); setRows(null);
      try {
        const res = await fetch(
          `/api/quickbooks/customer-invoices?businessId=${encodeURIComponent(businessId)}`,
          { signal: ctrl.signal },
        );
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) { setErr(data.error || `Failed to load invoices (${res.status})`); setRows([]); }
        else { setRows(data.invoices || []); setUnlinked(!!data.unlinked); }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof DOMException && e.name === 'AbortError'
          ? 'Timed out talking to QuickBooks — try again.'
          : 'Failed to load invoices.');
        setRows([]);
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); ctrl.abort(); };
  }, [businessId, attempt]);

  let body: ReactNode;
  if (!businessId || unlinked) body = <p className="text-xs text-gray-400">Not linked to a QuickBooks customer yet.</p>;
  else if (loading) body = <p className="text-xs text-gray-400">Loading invoices…</p>;
  else if (err) body = (
    <p className="text-xs text-red-600">
      {err}{' '}
      <button onClick={() => setAttempt((n) => n + 1)} className="underline font-medium">Retry</button>
    </p>
  );
  else if (rows === null || rows.length === 0) body = <p className="text-xs text-gray-400">No invoices found in QuickBooks.</p>;
  else body = (
    <ul className="divide-y divide-gray-100">
      {rows.map((inv) => (
        <li key={inv.id} className="flex items-center justify-between gap-2 py-1.5">
          <div className="min-w-0">
            <div className="text-xs font-medium">#{inv.docNumber || inv.id}</div>
            {inv.txnDate && <div className="text-[11px] text-gray-500">{fmtDay(inv.txnDate)}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right tabular-nums">
              <div className="text-xs font-semibold">${inv.total.toFixed(2)}</div>
              {inv.balance > 0 && <div className="text-[10px] text-amber-700">${inv.balance.toFixed(2)} due</div>}
            </div>
            <a
              href={`/api/quickbooks/invoice-pdf?id=${encodeURIComponent(inv.id)}&doc=${encodeURIComponent(inv.docNumber || inv.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2 py-1 rounded border border-brand-700 text-brand-700 hover:bg-gray-50 whitespace-nowrap font-medium"
            >
              PDF
            </a>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="bg-white border border-gray-200 rounded mt-2">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Invoices</span>
        {rows && !loading && !err && rows.length > 0 && (
          <span className="text-[10px] text-gray-400">{rows.length} · tap PDF to view / save</span>
        )}
      </div>
      <div className="px-3 pb-3 pt-1 border-t border-gray-100">
        {body}
      </div>
    </div>
  );
}

// Auto-refresh threshold — if no business has been synced in the past
// this many minutes, we kick off a sync in the background when the
// admin opens the page.
const STALE_MINUTES = 30;

type SalesRep = {
  id: string;
  full_name: string | null;
  email: string;
};

type DocStatus = {
  customer_id: string;
  doc_type: 'profile_sheet' | 'tax_exempt' | 'fein';
};

// A new signup claiming an existing business — sits here until admin
// approves or rejects via /api/business/[approve|reject]-link.
type LinkRequest = {
  id: string;
  created_at: string;
  claimed_name: string | null;
  claimed_address: string | null;
  profile: { id: string; full_name: string | null; email: string; phone: string | null } | null;
  business: { id: string; name: string; address: string | null } | null;
};

const DOC_LABELS: Record<DocStatus['doc_type'], string> = {
  profile_sheet: 'Profile',
  tax_exempt:    'TC-721',
  fein:          'W-9',
};

export default function AdminCustomersPage() {
  const supabase = createClient();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [docs, setDocs] = useState<DocStatus[]>([]);
  const [linkRequests, setLinkRequests] = useState<LinkRequest[]>([]);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [allBusinesses, setAllBusinesses] = useState<{ id: string; name: string; qb_customer_id: string | null }[]>([]);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Business ids whose location group is expanded (collapsed by default).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Edit-details modal: the customer being edited + the working form.
  const [editCust, setEditCust] = useState<Customer | null>(null);
  const [editForm, setEditForm] = useState<{ business_name: string; full_name: string; email: string; phone: string; address: string }>({ business_name: '', full_name: '', email: '', phone: '', address: '' });
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [filter, setFilter] = useState<'all' | 'incomplete' | 'complete'>('all');
  // Salesman filter: '' = all, a rep id, or '__unassigned__'.
  const [repFilter, setRepFilter] = useState<string>('');
  const [meRole, setMeRole] = useState<string | null>(null);
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [autoInvoiceByBiz, setAutoInvoiceByBiz] = useState<Map<string, boolean>>(new Map());
  // In-app order dates (customer_orders.created_at) grouped by customer id,
  // merged with cached QB invoice dates for the order-cadence + past-orders UI.
  const [appOrdersByCust, setAppOrdersByCust] = useState<Map<string, string[]>>(new Map());

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role, full_name, email').eq('id', user.id).single();
      setMeRole(data?.role ?? null);
      setMe({ id: user.id, name: data?.full_name || data?.email || 'Admin' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deleteCustomer(c: Customer) {
    if (!confirm(
      `Permanently delete ${c.business_name || c.full_name || c.email}?\n\n` +
      'This removes their account, login, orders, and documents. This cannot be undone.',
    )) return;
    const res = await fetch('/api/admin/delete-customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id }),
    });
    let j: { ok?: boolean; error?: string } = {};
    try { j = await res.json(); } catch { /* non-JSON error response */ }
    if (!res.ok || !j.ok) { alert(j.error || `Could not delete customer (HTTP ${res.status}).`); return; }
    setExpandedId(null);
    load();
  }

  // Re-pull just the documents so the File-status badges update after an
  // admin uploads/replaces a doc, without collapsing the expanded row.
  async function refreshDocs() {
    const { data } = await supabase
      .from('customer_documents')
      .select('customer_id, doc_type');
    setDocs((data as DocStatus[]) || []);
  }

  async function load() {
    setLoading(true);
    const [cust, docsRes, lrRes, repsRes, bizRes, spRes, ordersRes] = await Promise.all([
      supabase
        .from('profiles')
        .select(`
          id, email, full_name, business_name, phone, address, county, created_at, business_id,
          tax_exempt_applicable, w9_applicable,
          business:businesses!profiles_business_id_fkey(
            id, name, address, assigned_sales_rep_id, qb_balance, qb_oldest_open_invoice_date,
            qb_last_purchase_date, qb_recent_invoice_dates, qb_balance_synced_at, qb_payment_method, qb_payment_terms,
            billing_notes, active, last_activity_date, reactivated_at, parent_business_id
          )
        `)
        .eq('role', 'customer')
        .order('business_name', { ascending: true, nullsFirst: false })
        .order('email'),
      supabase
        .from('customer_documents')
        .select('customer_id, doc_type'),
      supabase
        .from('business_link_requests')
        .select(`
          id, created_at, claimed_name, claimed_address,
          profile:profiles!business_link_requests_profile_id_fkey(id, full_name, email, phone),
          business:businesses!business_link_requests_business_id_fkey(id, name, address)
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
      supabase
        .from('profiles')
        .select('id, full_name, email')
        .neq('role', 'customer')
        .order('full_name'),
      supabase
        .from('businesses')
        .select('id, name, qb_customer_id')
        .order('name'),
      // Auto-invoice flags — kept as its own query so a missing column can
      // never blank the customer list.
      supabase
        .from('businesses')
        .select('id, auto_invoice_orders'),
      // In-app order dates, newest-first, for the order-cadence bubble.
      supabase
        .from('customer_orders')
        .select('customer_id, created_at')
        .order('created_at', { ascending: false }),
    ]);
    // PostgREST returns the joined `business` as an array; collapse it to the
    // single row we expect (since profile.business_id is a 1:1 FK).
    const rows = (cust.data || []).map((c: any) => ({
      ...c,
      business: Array.isArray(c.business) ? c.business[0] || null : c.business || null,
    }));
    setCustomers(rows as Customer[]);
    // Group in-app order dates by customer (already newest-first from the query).
    const omap = new Map<string, string[]>();
    for (const o of (ordersRes.data as { customer_id: string | null; created_at: string }[]) || []) {
      if (!o.customer_id) continue;
      const list = omap.get(o.customer_id);
      if (list) list.push(o.created_at);
      else omap.set(o.customer_id, [o.created_at]);
    }
    setAppOrdersByCust(omap);
    setDocs((docsRes.data as DocStatus[]) || []);
    setLinkRequests((lrRes.data as unknown as LinkRequest[]) || []);
    setReps((repsRes.data as SalesRep[]) || []);
    setAllBusinesses((bizRes.data as { id: string; name: string; qb_customer_id: string | null }[]) || []);
    // Auto-invoice flags from the dedicated query (empty if the column
    // doesn't exist yet).
    const ai = new Map<string, boolean>();
    for (const b of (spRes.data as { id: string; auto_invoice_orders: boolean | null }[]) || []) {
      ai.set(b.id, !!b.auto_invoice_orders);
    }
    setAutoInvoiceByBiz(ai);
    setLoading(false);
  }

  // Confirm a customer's login email (when the Supabase confirmation email never
  // reached them, so they're stuck on "Email not confirmed").
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  async function confirmEmail(customerId: string) {
    setConfirmingId(customerId);
    try {
      const res = await fetch('/api/admin/confirm-customer-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
      });
      const json = await res.json();
      alert(json.ok ? 'Login email confirmed — they can sign in now.' : `Could not confirm: ${json.error || 'unknown'}`);
    } catch (e: any) {
      alert(`Could not confirm: ${e?.message || 'network'}`);
    } finally {
      setConfirmingId(null);
    }
  }

  // Set a new temporary password for a customer who's locked out. Shows the
  // temp password to hand over; they change it on next sign-in.
  const [resettingId, setResettingId] = useState<string | null>(null);
  async function resetPassword(customerId: string, label: string) {
    if (!confirm(`Reset the password for ${label}? This sets a new temporary password you'll give them.`)) return;
    setResettingId(customerId);
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: customerId }),
      });
      const json = await res.json();
      if (json.ok) {
        navigator.clipboard?.writeText(`Temp password: ${json.password}`).catch(() => {});
        alert(`New temporary password for ${label}:\n\n${json.password}\n\n(Copied to clipboard. They'll set their own on next sign-in.)`);
      } else {
        alert(`Could not reset password: ${json.error || 'unknown'}`);
      }
    } catch (e: any) {
      alert(`Could not reset password: ${e?.message || 'network'}`);
    } finally {
      setResettingId(null);
    }
  }

  // Manually reactivate an auto-deactivated customer. Sets reactivated_at so
  // the nightly job grants a fresh nine-month grace before deactivating again.
  async function reactivate(businessId: string) {
    const { error } = await supabase
      .from('businesses')
      .update({ active: true, reactivated_at: new Date().toISOString() })
      .eq('id', businessId);
    if (error) { alert('Could not reactivate: ' + error.message); return; }
    load();
  }

  // Manually deactivate (e.g. a customer who has never ordered and the auto
  // rule won't catch). Clears any reactivation grace so it stays gray.
  async function deactivate(businessId: string) {
    const { error } = await supabase
      .from('businesses')
      .update({ active: false, reactivated_at: null })
      .eq('id', businessId);
    if (error) { alert('Could not deactivate: ' + error.message); return; }
    load();
  }

  // Toggle whether staff-placed orders for this business skip approval and
  // auto-invoice + post to the warehouse.
  async function toggleAutoInvoice(businessId: string, on: boolean) {
    setAutoInvoiceByBiz((m) => new Map(m).set(businessId, on));
    await supabase.from('businesses').update({ auto_invoice_orders: on }).eq('id', businessId);
  }

  // Link a customer's profile to an existing business (unlocks their
  // checkout, which is gated on profiles.business_id).
  async function linkToBusiness(customerId: string, businessId: string) {
    if (!businessId) return;
    setLinkBusy(customerId);
    const { data, error } = await supabase
      .from('profiles')
      .update({ business_id: businessId })
      .eq('id', customerId)
      .select('id');
    setLinkBusy(null);
    if (error) { alert('Could not link: ' + error.message); return; }
    // RLS can silently match 0 rows (no error) if the admin update policy
    // isn't applied — catch that instead of falsely reporting success.
    if (!data || data.length === 0) {
      alert('Link did not save — your account may lack permission to edit customers. (DB policy "admins_update_any_profile" may be missing.)');
      return;
    }
    load();
  }

  async function unlinkBusiness(customerId: string) {
    if (!confirm('Unlink this customer from their business? Their login stays the same; they just won’t be tied to a business until re-linked (checkout is locked while unlinked).')) return;
    setLinkBusy(customerId);
    const { data, error } = await supabase
      .from('profiles')
      .update({ business_id: null, is_business_owner: false })
      .eq('id', customerId)
      .select('id');
    setLinkBusy(null);
    if (error) { alert('Could not unlink: ' + error.message); return; }
    if (!data || data.length === 0) { alert('Unlink did not save — permission issue (admins_update_any_profile policy).'); return; }
    load();
  }

  // Merge this customer's current business INTO another (e.g. a duplicate
  // created under a personal name → the real QB-synced business). Moves all
  // members + carries the QB id, then deletes the source business.
  async function mergeIntoBusiness(customerId: string, sourceBizId: string, targetBizId: string, targetName: string) {
    if (!targetBizId || sourceBizId === targetBizId) return;
    if (!confirm(`Merge into "${targetName}"?\n\n• "${targetName}" is KEPT (including its QuickBooks link).\n• This customer's login moves onto it.\n• The old duplicate business is removed.\n\nThis cannot be undone.`)) return;
    setLinkBusy(customerId);
    const { error } = await supabase.rpc('merge_businesses', { source_id: sourceBizId, target_id: targetBizId });
    if (error) { setLinkBusy(null); alert('Could not merge: ' + error.message); return; }
    // Verify it actually took — the customer should now point at the target,
    // and the old business should be gone. Catches a silent RLS no-op.
    const { data: check } = await supabase
      .from('profiles').select('business_id').eq('id', customerId).single();
    setLinkBusy(null);
    if (check?.business_id !== targetBizId) {
      alert('Merge did not complete — your account may lack permission (DB function merge_businesses / admins_update_any_profile policy not applied).');
      return;
    }
    alert(`Merged. This customer is now on "${targetName}" and keeps their login.`);
    load();
  }

  // Merge a DUPLICATE customer record into this one and remove it. The side with
  // a login is always kept; the other's orders/documents/QB link move onto the
  // survivor. Fixes two cards for the same real customer.
  async function mergeDuplicate(thisId: string, otherId: string, otherLabel: string) {
    if (!otherId || otherId === thisId) return;
    if (!confirm(`Merge the duplicate "${otherLabel}" into this customer?\n\n• The record with a login is kept; the other is removed.\n• Its orders, documents and QuickBooks link move onto the survivor.\n\nThis cannot be undone.`)) return;
    setLinkBusy(thisId);
    try {
      const res = await fetch('/api/admin/merge-customers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_id: thisId, remove_id: otherId }),
      });
      const j = await res.json();
      if (!j.ok) { alert('Could not merge: ' + (j.error || 'unknown')); return; }
      alert('Merged — the duplicate has been removed.');
      load();
    } catch (e) {
      alert('Could not merge: ' + (e instanceof Error ? e.message : 'network error'));
    } finally {
      setLinkBusy(null);
    }
  }

  // Create a new business from the customer's own info and link them as owner.
  async function createBusinessAndLink(c: Customer) {
    const name = (c.business_name || c.full_name || c.email || '').trim();
    if (!name) { alert('This customer has no business name to create from.'); return; }
    if (!confirm(`Create business "${name}" and link ${c.full_name || c.email} to it?`)) return;
    setLinkBusy(c.id);
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .insert({ name, address: c.address || null })
      .select('id')
      .single();
    if (bizErr || !biz) { setLinkBusy(null); alert('Could not create business: ' + (bizErr?.message || 'unknown')); return; }
    const { error: upErr } = await supabase
      .from('profiles')
      .update({ business_id: biz.id, is_business_owner: true })
      .eq('id', c.id);
    setLinkBusy(null);
    if (upErr) { alert('Business created but linking failed: ' + upErr.message); return; }
    load();
  }

  async function assignRep(businessId: string, repId: string | null) {
    await supabase
      .from('businesses')
      .update({ assigned_sales_rep_id: repId })
      .eq('id', businessId);
    load();
  }

  async function setCustomerCounty(customerId: string, county: string | null) {
    await supabase
      .from('profiles')
      .update({ county })
      .eq('id', customerId);
    load();
  }

  async function refreshBalances() {
    setSyncBusy(true);
    setSyncResult('');
    try {
      const res = await fetch('/api/quickbooks/sync-balances', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        setSyncResult(`Synced ${json.synced} of ${json.total ?? json.synced} customers from QuickBooks.`);
        load();
      } else {
        setSyncResult(`Error: ${json.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSyncResult(`Error: ${e.message || 'network'}`);
    }
    setSyncBusy(false);
  }

  // Auto-refresh whenever the cache is stale — first time visiting, or
  // anything older than STALE_MINUTES. The admin sees cached numbers
  // immediately and fresh ones show up a few seconds later.
  useEffect(() => {
    if (loading || customers.length === 0 || syncBusy) return;
    const stale = customers.every((c) => {
      const t = c.business?.qb_balance_synced_at;
      if (!t) return true;
      const ageMin = (Date.now() - new Date(t).getTime()) / 60000;
      return ageMin > STALE_MINUTES;
    });
    if (stale) refreshBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, customers.length]);

  function daysSince(iso: string | null): number | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const ms = Date.now() - d.getTime();
    return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  }

  useEffect(() => { load(); }, []);

  async function approveLink(id: string) {
    setReviewBusy(id);
    const res = await fetch('/api/business/approve-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: id }),
    });
    const json = await res.json();
    setReviewBusy(null);
    if (!json.ok) {
      alert(json.error || 'Approval failed.');
      return;
    }
    load();
  }

  async function rejectLink(id: string) {
    const note = prompt('Optional note for the customer (or leave blank):') || '';
    setReviewBusy(id);
    const res = await fetch('/api/business/reject-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: id, note }),
    });
    const json = await res.json();
    setReviewBusy(null);
    if (!json.ok) {
      alert(json.error || 'Rejection failed.');
      return;
    }
    load();
  }

  function docsFor(customerId: string): Set<DocStatus['doc_type']> {
    return new Set(
      docs.filter((d) => d.customer_id === customerId).map((d) => d.doc_type),
    );
  }

  // Placeholder addresses we mint for QB-imported customers without a real
  // inbox don't count as a real email on file.
  function hasRealEmail(email: string | null): boolean {
    return !!email && !email.toLowerCase().endsWith('@stallion.local');
  }

  // A customer's file is complete when we have their profile sheet, the four
  // core profile fields, and any document the admin has marked applicable.
  function missingItems(c: Customer): string[] {
    const have = docsFor(c.id);
    const missing: string[] = [];
    // A linked business (esp. from QuickBooks) is the system of record for the
    // company's name/address/contact, so don't flag those on the profile when
    // it's linked — only genuinely missing DOCUMENTS should count there.
    const linked = !!c.business_id;
    if (!c.business?.name?.trim() && !c.business_name?.trim()) missing.push('Business name');
    if (!linked && !c.address?.trim()) missing.push('Address');
    if (!linked && !hasRealEmail(c.email)) missing.push('Email');
    if (!linked && !c.phone?.trim()) missing.push('Phone');
    if (!have.has('profile_sheet')) missing.push('Customer profile');
    if (c.tax_exempt_applicable && !have.has('tax_exempt')) missing.push('TC-721 (tax-exempt)');
    if (c.w9_applicable && !have.has('fein')) missing.push('W-9');
    return missing;
  }

  // An assigned rep can be ANY user, so resolve names from every profile we've
  // loaded (reps = staff, customers = the rest) rather than only the staff
  // list — otherwise a rep whose own profile is customer-role shows blank.
  const userNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reps) m.set(r.id, r.full_name || r.email);
    for (const c of customers) m.set(c.id, c.full_name || c.business_name || c.email);
    return m;
  }, [reps, customers]);

  function repName(id: string | null | undefined): string | null {
    if (!id) return null;
    return userNames.get(id) || null;
  }

  async function setDocApplicable(c: Customer, field: 'tax_exempt_applicable' | 'w9_applicable', value: boolean) {
    setCustomers((prev) => prev.map((x) => (x.id === c.id ? { ...x, [field]: value } : x)));
    await supabase.from('profiles').update({ [field]: value }).eq('id', c.id);
  }

  function openEdit(c: Customer) {
    setEditErr('');
    setEditForm({
      business_name: c.business?.name || c.business_name || '',
      full_name: c.full_name || '',
      email: c.email?.endsWith('@stallion.local') ? '' : (c.email || ''),
      phone: c.phone || '',
      address: c.address || '',
    });
    setEditCust(c);
  }

  async function saveEdit() {
    if (!editCust) return;
    setEditBusy(true); setEditErr('');
    try {
      const res = await fetch('/api/admin/edit-customer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: editCust.id, ...editForm }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setEditErr(j.error || 'Could not save.'); return; }
      if (j.email_note) alert(j.email_note);
      setEditCust(null);
      load();
    } catch {
      setEditErr('Network error.');
    } finally {
      setEditBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return customers.filter((c) => {
      // Text search
      if (term) {
        const hay = [
          c.business?.name,
          c.business_name,
          c.full_name,
          c.email,
          c.phone,
          c.address,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      // Filter chip
      const incomplete = missingItems(c).length > 0;
      if (filter === 'incomplete' && !incomplete) return false;
      if (filter === 'complete' && incomplete) return false;
      // Salesman filter ('' = all)
      if (repFilter) {
        const repId = c.business?.assigned_sales_rep_id || '__unassigned__';
        if (repId !== repFilter) return false;
      }
      return true;
    });
  }, [customers, docs, q, filter, repFilter]);

  // Location grouping: a customer whose business has a parent_business_id is a
  // location (QB sub-customer). Render it nested under its parent, collapsed by
  // default. `display` is the flat render order (parent, then its expanded
  // locations); `childCountByBiz` powers the "N locations" toggle on parents.
  const { display, childCountByBiz } = useMemo(() => {
    const childrenByParent = new Map<string, Customer[]>();
    for (const c of filtered) {
      const pid = c.business?.parent_business_id;
      if (pid) { const a = childrenByParent.get(pid) || []; a.push(c); childrenByParent.set(pid, a); }
    }
    const present = new Set(filtered.map((c) => c.business?.id).filter(Boolean) as string[]);
    const list: { c: Customer; isChild: boolean }[] = [];
    for (const c of filtered) {
      const pid = c.business?.parent_business_id;
      if (pid && present.has(pid)) continue; // shown under its parent below
      list.push({ c, isChild: false });
      const bid = c.business?.id;
      const kids = bid ? childrenByParent.get(bid) : undefined;
      if (bid && kids && kids.length && expandedGroups.has(bid)) {
        for (const k of kids) list.push({ c: k, isChild: true });
      }
    }
    const counts = new Map<string, number>();
    childrenByParent.forEach((v, k) => counts.set(k, v.length));
    return { display: list, childCountByBiz: counts };
  }, [filtered, expandedGroups]);
  const toggleGroup = (bizId: string) =>
    setExpandedGroups((prev) => { const n = new Set(prev); n.has(bizId) ? n.delete(bizId) : n.add(bizId); return n; });

  // Every staff member can be a rep, so the dropdown lists them all (sorted by
  // name) — not just those already assigned — so admins/master_admins show up.
  const repSelectOptions = useMemo(
    () => reps
      .map((r) => ({ id: r.id, name: r.full_name || r.email }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [reps],
  );
  const hasUnassigned = useMemo(
    () => customers.some((c) => !c.business?.assigned_sales_rep_id),
    [customers],
  );

  const incompleteCount = useMemo(
    () => customers.filter((c) => missingItems(c).length > 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customers, docs],
  );

  // Total balance owed across all customers — summed once per business (several
  // profiles can share one business, whose row holds the QB balance) so shared
  // accounts aren't double-counted. Admin-only.
  const totalOwed = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0;
    for (const c of customers) {
      const b = c.business;
      if (!b?.id || seen.has(b.id)) continue;
      seen.add(b.id);
      if (b.qb_balance != null) sum += Number(b.qb_balance);
    }
    return sum;
  }, [customers]);
  const isAdmin = meRole === 'admin' || meRole === 'master_admin';

  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/admin/customers', label: 'Existing customers' },
          { href: '/admin/forms', label: 'Forms' },
        ]}
      />
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <div className="flex flex-col items-end gap-1">
          {isAdmin && (
            <div className="text-xs text-gray-600">
              Total balance owed:{' '}
              <span className={`font-semibold tabular-nums ${totalOwed > 0 ? 'text-amber-700' : 'text-gray-700'}`}>
                ${totalOwed.toFixed(2)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
          <button
            onClick={refreshBalances}
            disabled={syncBusy}
            className="px-2.5 py-1 text-xs bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-60 font-medium"
          >
            {syncBusy ? 'Syncing…' : '↻ Refresh balances from QB'}
          </button>
          </div>
        </div>
      </div>

      {(syncResult || syncBusy) && (
        <p className={`text-xs mb-3 ${syncResult.startsWith('Error') ? 'text-red-700' : 'text-gray-600'}`}>
          {syncBusy ? 'Pulling balances + open invoices from QuickBooks (5-15 seconds)…' : syncResult}
        </p>
      )}

      {/* Account-link approval queue — sits up top so it's never missed. */}
      {linkRequests.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
          <h2 className="font-semibold text-amber-900 mb-3">
            Account link requests
            <span className="font-normal text-amber-800/70"> ({linkRequests.length})</span>
          </h2>
          <p className="text-xs text-amber-900/80 mb-3">
            New signups claiming an existing business. Approve to link their profile;
            reject if you don&apos;t recognize them.
          </p>
          <div className="space-y-2">
            {linkRequests.map((r) => (
              <div key={r.id} className="bg-white border border-amber-200 rounded-md p-3">
                <div className="flex justify-between items-start gap-2 flex-wrap mb-2">
                  <div className="min-w-0">
                    <div className="text-sm">
                      <span className="font-medium">
                        {r.profile?.full_name || r.profile?.email || 'Unknown user'}
                      </span>
                      <span className="text-gray-600"> ({r.profile?.email})</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      {r.profile?.phone && <>{r.profile.phone} · </>}
                      Requested {new Date(r.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                    </div>
                  </div>
                </div>
                <div className="text-xs bg-amber-50 border border-amber-100 rounded p-2 mb-3">
                  <div className="font-medium text-amber-900">Claiming:</div>
                  <div className="text-amber-900">{r.business?.name || r.claimed_name}</div>
                  {(r.business?.address || r.claimed_address) && (
                    <div className="text-amber-900/80 whitespace-pre-wrap">
                      {r.business?.address || r.claimed_address}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => approveLink(r.id)}
                    disabled={reviewBusy === r.id}
                    className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded hover:bg-brand-900 disabled:opacity-50 font-medium"
                  >
                    {reviewBusy === r.id ? 'Working…' : 'Approve link'}
                  </button>
                  <button
                    onClick={() => rejectLink(r.id)}
                    disabled={reviewBusy === r.id}
                    className="px-3 py-1.5 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4 space-y-3">
        <input
          type="text"
          placeholder="Search by business, name, email, phone, or address…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
        />
        {/* Single-line, horizontally scrollable so the chips never stack. */}
        <div className="flex flex-nowrap gap-2 items-center overflow-x-auto scrollbar-hide">
          <span className="text-xs font-medium text-gray-600 shrink-0">Show:</span>
          {(['all', 'incomplete', 'complete'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md border whitespace-nowrap shrink-0 ${
                filter === f
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'bg-white border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f === 'all' ? 'All' : f === 'incomplete' ? `Missing docs${incompleteCount ? ` (${incompleteCount})` : ''}` : 'Complete files'}
            </button>
          ))}
          <span className="text-xs text-gray-500 shrink-0 ml-auto pl-2">
            {filtered.length} of {customers.length}
          </span>
        </div>
        {repSelectOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600 shrink-0">Rep:</span>
            <select
              value={repFilter}
              onChange={(e) => setRepFilter(e.target.value)}
              className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white max-w-[220px]"
            >
              <option value="">All reps</option>
              {repSelectOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
              {hasUnassigned && <option value="__unassigned__">— Unassigned —</option>}
            </select>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">No matching customers.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {display.map(({ c, isChild }) => {
            const isExpanded = expandedId === c.id;
            const childCount = c.business?.id ? (childCountByBiz.get(c.business.id) || 0) : 0;
            const groupOpen = c.business?.id ? expandedGroups.has(c.business.id) : false;
            const biz = c.business;
            // Other customer records with the same business name — likely
            // duplicates of this one that can be merged away.
            const cName = normBizName(c.business?.name || c.business_name || '');
            const dupCandidates = cName
              ? customers.filter((o) => o.id !== c.id && normBizName(o.business?.name || o.business_name || '') === cName)
              : [];
            const balance = biz?.qb_balance != null ? Number(biz.qb_balance) : null;
            const oldestAge = daysSince(biz?.qb_oldest_open_invoice_date || null);
            const lastPurchase = biz?.qb_last_purchase_date || null;
            const terms = termsBadge(biz?.qb_payment_method || null, biz?.qb_payment_terms || null);
            const assignedRep = repName(biz?.assigned_sales_rep_id);
            const missing = missingItems(c);
            // Order cadence = in-app orders + recent QB invoices, deduped by day.
            const cadence = orderCadence([
              ...(appOrdersByCust.get(c.id) || []),
              ...(biz?.qb_recent_invoice_dates || []),
            ]);
            // Inactive = most recent order/invoice is over 9 months old (unless
            // an admin reactivated recently). Computed straight from the dates
            // we already loaded — independent of the nightly job — so the whole
            // box renders grayscale (even the colored bubbles) right away.
            const lastActivity = latestDay([
              lastPurchase,
              ...(appOrdersByCust.get(c.id) || []),
              ...(biz?.qb_recent_invoice_dates || []),
            ]);
            // Inactive when an admin manually deactivated it OR it's auto-stale
            // (no orders in 9+ months). A recent manual reactivation overrides.
            const inactive = biz?.active === false || isInactive(lastActivity, biz?.reactivated_at || null);
            return (
              <div key={c.id} className={`${inactive ? 'bg-gray-200' : ''} ${isChild ? 'pl-4 border-l-4 border-brand-200 bg-brand-50/40' : ''}`}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : c.id)}
                  className={`w-full text-left px-4 py-3 ${inactive ? 'grayscale opacity-80 bg-gray-200 hover:bg-gray-300' : 'hover:bg-gray-50'}`}
                >
                  {/* Payment terms + missing-documents badges at the top of the box */}
                  {(terms || missing.length > 0 || inactive || (c.email || '').toLowerCase().endsWith('@stallionfieldtickets.com')) && (
                    <div className="mb-1 flex flex-wrap gap-1">
                      {(c.email || '').toLowerCase().endsWith('@stallionfieldtickets.com') && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap bg-amber-100 text-amber-900 border-amber-300"
                          title="@stallionfieldtickets.com email on a customer login — this may be staff who signed up the wrong way. Expand to make them staff.">
                          Staff email?
                        </span>
                      )}
                      {inactive && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap bg-gray-200 text-gray-600 border-gray-300">
                          Inactive
                        </span>
                      )}
                      {terms && (
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${tonalClass(terms.tone)}`}>
                          {terms.label}
                        </span>
                      )}
                      {missing.length > 0 && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap bg-red-50 text-red-700 border-red-200">
                          Missing documents ({missing.length})
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">
                      {isChild && <span className="text-brand-400 mr-1">↳</span>}
                      {c.business?.name || c.business_name || c.full_name || c.email}
                      {childCount > 0 && c.business?.id && (
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); toggleGroup(c.business!.id); }}
                          className="ml-2 inline-flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-brand-50 text-brand-800 border-brand-200 cursor-pointer align-middle whitespace-nowrap"
                        >
                          {childCount} location{childCount === 1 ? '' : 's'} {groupOpen ? '▾' : '▸'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {[c.full_name || c.business_name || null, c.email, c.phone].filter(Boolean).join(' · ')}
                    </div>
                  </div>

                  {/* Right side: balance + oldest/last invoice. */}
                  <div className="shrink-0 text-right min-w-[110px]">
                    {/* Two order boxes: how often they order (left) and the
                        countdown to their next expected order (right). */}
                    {cadence && (
                      <div className="flex items-stretch justify-end gap-1.5 mb-1.5">
                        <div
                          title={`Orders about every ${cadence.avgDays} days`}
                          className="px-2 py-1 rounded-md border bg-gray-50 border-gray-200 text-center min-w-[44px]"
                        >
                          <div className="text-sm font-bold tabular-nums text-gray-700 leading-none">{cadence.avgDays}d</div>
                          <div className="text-[8px] uppercase tracking-wide text-gray-400 mt-0.5 leading-none">every</div>
                        </div>
                        <div
                          title={`Next order expected ${fmtDay(cadence.expectedNext.toISOString().slice(0, 10))}`}
                          className={`px-2 py-1 rounded-md border text-center min-w-[44px] ${cadenceClass(cadence.countdownDays)}`}
                        >
                          <div className="text-sm font-bold tabular-nums leading-none">
                            {cadence.countdownDays < 0 ? `${cadence.countdownDays}d` : `${cadence.countdownDays}d`}
                          </div>
                          <div className="text-[8px] uppercase tracking-wide opacity-70 mt-0.5 leading-none">
                            {cadence.countdownDays < 0 ? 'late' : 'next'}
                          </div>
                        </div>
                      </div>
                    )}
                    {balance != null ? (
                      <div className={`text-sm font-semibold tabular-nums ${balance > 0 ? 'text-amber-700' : 'text-gray-500'}`}>
                        ${balance.toFixed(2)}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-400 italic">no QB sync</div>
                    )}
                    {oldestAge != null && balance != null && balance > 0 && biz?.qb_oldest_open_invoice_date && (
                      <div className={`text-[11px] ${oldestAge > 60 ? 'text-red-700' : oldestAge > 30 ? 'text-amber-700' : 'text-gray-500'}`}>
                        oldest invoice {new Date(biz.qb_oldest_open_invoice_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}
                      </div>
                    )}
                    {lastPurchase && (
                      <div className="text-[10px] text-gray-400">
                        last invoice {new Date(lastPurchase + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}
                      </div>
                    )}
                  </div>

                  <span className="text-gray-400 text-sm ml-1">{isExpanded ? '▾' : '▸'}</span>
                  </div>

                  {/* Bottom row: assigned rep. */}
                  <div className="flex items-end gap-2 mt-1.5">
                    <span className="text-[10px] flex-1 min-w-0 truncate text-left self-center">
                      {assignedRep
                        ? <span className="text-gray-600 font-medium">Rep: {assignedRep}</span>
                        : biz
                          ? <span className="text-gray-400">No rep assigned</span>
                          : null}
                    </span>
                    <span className="flex-1" />
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                    {c.business_id && (
                      <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-gray-100 border border-gray-200 px-3 py-2">
                        <span className="text-xs text-gray-600">
                          {inactive
                            ? `Inactive${lastActivity ? ` — last order ${fmtDay(lastActivity)}` : ' — no orders on record'}.`
                            : `Active${lastActivity ? ` — last order ${fmtDay(lastActivity)}` : ' — no orders yet'}.`}
                        </span>
                        {inactive ? (
                          <button onClick={() => reactivate(c.business_id!)}
                            className="px-3 py-1 text-xs rounded-md bg-brand-600 text-white whitespace-nowrap">
                            Reactivate
                          </button>
                        ) : (
                          <button onClick={() => deactivate(c.business_id!)}
                            className="px-3 py-1 text-xs rounded-md border border-gray-300 text-gray-700 whitespace-nowrap">
                            Deactivate
                          </button>
                        )}
                      </div>
                    )}
                    {/* Fix a stuck login — confirm the customer's email if the
                        Supabase confirmation never reached them, or reset their
                        password if they're locked out. */}
                    {hasRealEmail(c.email) && (
                      <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 flex-wrap">
                        <span className="text-xs text-blue-900">Locked out?</span>
                        <div className="flex gap-2">
                          <button onClick={() => confirmEmail(c.id)} disabled={confirmingId === c.id}
                            className="px-3 py-1 text-xs rounded-md bg-blue-600 text-white whitespace-nowrap disabled:opacity-50">
                            {confirmingId === c.id ? 'Confirming…' : 'Confirm login'}
                          </button>
                          <button onClick={() => resetPassword(c.id, c.business_name || c.full_name || c.email)} disabled={resettingId === c.id}
                            className="px-3 py-1 text-xs rounded-md bg-amber-600 text-white whitespace-nowrap disabled:opacity-50">
                            {resettingId === c.id ? 'Resetting…' : 'Reset password'}
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Two columns: account controls on the left (kept narrow),
                        rolling 12-month Past Orders list on the right. */}
                    <div className="flex flex-col sm:flex-row gap-4 items-start">
                      <div className="flex-1 min-w-0 w-full">
                    {c.address && (
                      <div className="text-xs text-gray-600 mb-3 whitespace-pre-wrap">
                        <span className="font-medium text-gray-700">Address:</span> {c.address}
                      </div>
                    )}
                    {/* Edit the customer's name / contact / address. */}
                    <div className="mb-3 flex items-center gap-2 flex-wrap">
                      <button
                        onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                        className="px-3 py-1.5 text-xs rounded-md bg-amber-100 text-amber-900 hover:bg-amber-200 font-medium"
                      >
                        Edit details
                      </button>
                    </div>

                    {/* Single merge control: attach this login to a QuickBooks
                        customer. The chosen QuickBooks account is KEPT (its name
                        comes from QuickBooks); this customer's login moves onto it
                        — whether or not they already have a business. */}
                    <div className="mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="text-xs font-medium text-gray-700">Business:</label>
                        {c.business_id ? (
                          <span className="text-xs text-gray-700">{c.business?.name || c.business_name || 'Linked'}</span>
                        ) : (
                          <span className="text-[11px] font-semibold text-red-700">Not linked — checkout locked</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap mt-1.5">
                        {c.business_id ? (
                          <select
                            defaultValue=""
                            disabled={linkBusy === c.id}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const v = e.target.value;
                              const name = e.currentTarget.options[e.currentTarget.selectedIndex]?.text || '';
                              e.currentTarget.value = '';
                              if (v) mergeIntoBusiness(c.id, c.business_id!, v, name);
                            }}
                            className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-full max-w-[280px]"
                            title="Merge with a QuickBooks customer — that account is kept (name comes from QuickBooks); this customer's login moves onto it."
                          >
                            <option value="">Merge with a QuickBooks customer (keeps this login)…</option>
                            {allBusinesses.filter((b) => b.id !== c.business_id && b.qb_customer_id).map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                        ) : (
                          <select
                            defaultValue=""
                            disabled={linkBusy === c.id}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => { const v = e.target.value; e.currentTarget.value = ''; if (v) linkToBusiness(c.id, v); }}
                            className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-full max-w-[280px]"
                            title="Attach this customer's login to a QuickBooks customer (name comes from QuickBooks)."
                          >
                            <option value="">Merge with a QuickBooks customer (keeps this login)…</option>
                            {allBusinesses.filter((b) => b.qb_customer_id).map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                        )}
                        {/* Duplicate QuickBooks placeholder card (synthetic login)
                            left behind after a merge — any admin can remove it.
                            Only for UNLINKED placeholders: a real QB customer is
                            linked to a business, and an email-less QB customer
                            also gets a synthetic @stallion.local address, so
                            requiring "no business" stops real customers from
                            being one-click deleted by mistake. */}
                        {c.email.endsWith('@stallion.local') && !c.business_id && (meRole === 'admin' || meRole === 'master_admin') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteCustomer(c); }}
                            disabled={linkBusy === c.id}
                            className="px-2 py-1 text-xs rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                            title="Delete this unlinked QuickBooks duplicate card (no real login, no business)"
                          >
                            Delete duplicate
                          </button>
                        )}
                        {(meRole === 'admin' || meRole === 'master_admin') && dupCandidates.length > 0 && (
                          <select
                            defaultValue=""
                            disabled={linkBusy === c.id}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const v = e.target.value;
                              const label = e.currentTarget.options[e.currentTarget.selectedIndex]?.text || 'duplicate';
                              e.currentTarget.value = '';
                              if (v) mergeDuplicate(c.id, v, label);
                            }}
                            className="px-2 py-1 text-xs border border-amber-400 rounded bg-white w-full max-w-[280px]"
                            title="Merge another record for this same customer into this one — removes the duplicate and keeps the login."
                          >
                            <option value="">Merge a duplicate of this customer…</option>
                            {dupCandidates.map((o) => (
                              <option key={o.id} value={o.id}>{(o.full_name || o.email)}{o.business_name || o.business?.name ? ` · ${o.business?.name || o.business_name}` : ''}</option>
                            ))}
                          </select>
                        )}
                        {linkBusy === c.id && <span className="text-[10px] text-gray-400">Working…</span>}
                      </div>
                    </div>
                    {biz && (
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <label className="text-xs font-medium text-gray-700">Assigned sales rep:</label>
                        <select
                          value={biz.assigned_sales_rep_id || ''}
                          onChange={(e) => assignRep(biz.id, e.target.value || null)}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-full max-w-[200px]"
                        >
                          <option value="">— Unassigned —</option>
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>{r.full_name || r.email}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {biz && (
                      <BillingNotesBox businessId={biz.id} initial={biz.billing_notes} />
                    )}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <label className="text-xs font-medium text-gray-700">County:</label>
                      <select
                        value={c.county || ''}
                        onChange={(e) => setCustomerCounty(c.id, e.target.value || null)}
                        onClick={(e) => e.stopPropagation()}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white w-full max-w-[200px]"
                      >
                        <option value="">— Not set —</option>
                        {COUNTIES.map((county) => (
                          <option key={county} value={county}>{county}</option>
                        ))}
                      </select>
                      <span className="text-[10px] text-gray-400">Controls which reps the customer can request</span>
                    </div>
                      </div>
                      {/* Past Orders — rolling last 12 months, two columns,
                          newest first. In-app orders + QuickBooks invoices.
                          Invoice PDFs sit just below it, filling the column. */}
                      <div className="w-full sm:w-[240px] shrink-0">
                        <div className="text-xs font-semibold text-gray-700">Past Orders</div>
                        <div className="text-[10px] text-gray-400 mb-1.5">last 12 months</div>
                        {cadence ? (
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                            {cadence.days.map((d, i) => (
                              <span key={d + i} className="text-[11px] tabular-nums text-gray-600">{fmtDay(d)}</span>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-gray-400 italic">No orders yet</div>
                        )}
                        <CustomerInvoices businessId={c.business?.id ?? null} />
                      </div>
                    </div>
                    {/* Auto-invoice: staff-placed orders for this customer
                        skip approval. Admins/master only. */}
                    {c.business_id && (
                      <div className="mb-3 bg-white border border-gray-200 rounded p-3" onClick={(e) => e.stopPropagation()}>
                        <label className="flex items-start gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            checked={autoInvoiceByBiz.get(c.business_id) ?? false}
                            onChange={(e) => toggleAutoInvoice(c.business_id!, e.target.checked)}
                            className="w-4 h-4 mt-0.5"
                          />
                          <span>
                            Skip approval — auto-invoice &amp; post to warehouse
                            <span className="block text-[11px] font-normal text-gray-500 mt-0.5">
                              Staff-placed orders are invoiced in QuickBooks and sent to the warehouse
                              automatically. If QuickBooks fails, the order falls back to approval.
                            </span>
                          </span>
                        </label>
                      </div>
                    )}
                    {/* File completeness — what's still missing, plus the
                        per-customer applicability toggles for the two
                        conditional forms. */}
                    <div className="mb-3 bg-white border border-gray-200 rounded p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">File status</span>
                        {missing.length === 0 ? (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                            Complete ✓
                          </span>
                        ) : (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200">
                            Missing documents ({missing.length})
                          </span>
                        )}
                      </div>
                      {missing.length > 0 && (
                        <ul className="text-xs text-red-700 mb-2 list-disc pl-5 space-y-0.5">
                          {missing.map((m) => <li key={m}>{m}</li>)}
                        </ul>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-gray-700">
                          <input
                            type="checkbox"
                            checked={c.tax_exempt_applicable}
                            onChange={(e) => { e.stopPropagation(); setDocApplicable(c, 'tax_exempt_applicable', e.target.checked); }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4"
                          />
                          TC-721 (tax-exempt form) applies to this customer
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-700">
                          <input
                            type="checkbox"
                            checked={c.w9_applicable}
                            onChange={(e) => { e.stopPropagation(); setDocApplicable(c, 'w9_applicable', e.target.checked); }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4"
                          />
                          W-9 applies to this customer
                        </label>
                      </div>
                    </div>
                    {/* Documents tucked behind a disclosure — admins
                        check these once a year, so they shouldn't take
                        up the bulk of the expanded row by default. */}
                    <details className="bg-white border border-gray-200 rounded group">
                      <summary
                        onClick={(e) => e.stopPropagation()}
                        className="px-3 py-2 cursor-pointer select-none flex items-center justify-between hover:bg-gray-50 rounded"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Documents
                        </span>
                        <span className="text-[10px] text-gray-400 group-open:hidden">
                          Profile · TC-721 · W-9
                        </span>
                        <span className="text-[10px] text-gray-400 hidden group-open:inline">
                          Hide
                        </span>
                      </summary>
                      <div
                        className="px-3 pb-3 pt-1 border-t border-gray-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <CustomerDocuments customerId={c.id} onChanged={refreshDocs} />
                      </div>
                    </details>
                    {meRole === 'master_admin' && (
                      <div className="mt-3 pt-3 border-t border-gray-100">
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteCustomer(c); }}
                          className="text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-700 hover:bg-red-50"
                        >
                          Delete customer
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit customer details */}
      {editCust && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-3" onClick={() => setEditCust(null)}>
          <div className="bg-white rounded-lg w-full max-w-md my-8 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <h2 className="font-semibold text-sm">Edit customer</h2>
              <button onClick={() => setEditCust(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {([
                ['business_name', 'Business name'],
                ['full_name', 'Contact name'],
                ['email', 'Email (login)'],
                ['phone', 'Phone'],
                ['address', 'Address'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block text-xs text-gray-600">{label}
                  {key === 'address' ? (
                    <textarea value={editForm[key]} onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                      rows={2} className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
                  ) : (
                    <input value={editForm[key]} onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                      className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
                  )}
                </label>
              ))}
              <p className="text-[11px] text-gray-400">
                Business name, phone &amp; address also update the linked business. Changing the email updates their login too.
              </p>
              {editErr && <p className="text-xs text-red-600">{editErr}</p>}
              <div className="flex gap-2 pt-1">
                <button onClick={saveEdit} disabled={editBusy}
                  className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
                  {editBusy ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditCust(null)} className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
