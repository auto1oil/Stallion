'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

type OrderRow = {
  id: string;
  status: string;
  invoice_number: string | null;
  delivery_address: string | null;
  notes: string | null;
  created_at: string;
  customer_id: string;
  sales_rep_id: string | null;
  submitted_by_id: string | null;
  customer_order_items: Array<{ id: string }>;
  customer: { full_name: string | null; email: string; business_name: string | null; phone: string | null } | null;
  sales_rep: { full_name: string | null; email: string } | null;
  submitted_by: { full_name: string | null; email: string; role: string } | null;
};

// A new signup that needs the admin to approve their account before they can
// order. Two shapes: an explicit link request (claiming an existing business),
// or a self-signup that ended up with no business and no request.
type AccountReq = {
  id: string;
  claimed_name: string | null;
  created_at: string;
  profile: { id: string; full_name: string | null; email: string; phone: string | null } | null;
  business: { id: string; name: string } | null;
};
type UnlinkedCustomer = {
  id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  business_name: string | null;
  address: string | null;
  created_at: string;
};

const DOC_DEFS: { key: string; label: string }[] = [
  { key: 'profile_sheet', label: 'Profile' },
  { key: 'tax_exempt', label: 'TC-721' },
  { key: 'fein', label: 'W-9' },
];

function statusBadge(s: string) {
  const m: Record<string, string> = {
    pending:    'bg-amber-50  text-amber-800  border-amber-200',
    invoiced:   'bg-blue-50   text-blue-800   border-blue-200',
    dispatched: 'bg-green-50  text-green-800  border-green-200',
    cancelled:  'bg-gray-100  text-gray-700   border-gray-300',
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${m[s] || ''}`}>
      {s}
    </span>
  );
}

export default function AdminCustomerOrdersPage() {
  const supabase = createClient();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [loading, setLoading] = useState(true);
  const [linkReqs, setLinkReqs] = useState<AccountReq[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedCustomer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [meRole, setMeRole] = useState<string | null>(null);
  const [docsByCustomer, setDocsByCustomer] = useState<Map<string, Set<string>>>(new Map());
  const [onHoldIds, setOnHoldIds] = useState<Set<string>>(new Set());
  // Per-order "why it didn't auto-post" notes. Loaded separately + tolerantly
  // so a not-yet-applied auto_post_error column can't break the orders list.
  const [autoErrors, setAutoErrors] = useState<Map<string, string>>(new Map());

  async function holdAndEmail(profileId: string, email: string, name: string, missing: string[]) {
    await supabase.from('profiles').update({ on_hold: true }).eq('id', profileId);
    const subject = encodeURIComponent('Stallion — documents needed to finish setting up your account');
    const body = encodeURIComponent(
      `Hi ${name},\n\nThanks for signing up with Stallion. Before we can finish setting up your account, ` +
      `we still need the following:\n\n${missing.map((m) => `• ${m}`).join('\n')}\n\n` +
      `Please reply with these and we'll get you set up right away.\n\nThank you,\nStallion`,
    );
    if (email && !email.endsWith('@stallion.local')) {
      window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
    } else {
      alert('Placed on hold. (No email on file to message this customer.)');
    }
    loadAccountApprovals();
  }

  async function releaseHold(profileId: string) {
    await supabase.from('profiles').update({ on_hold: false }).eq('id', profileId);
    loadAccountApprovals();
  }

  async function deleteAccount(id: string, label: string) {
    if (!confirm(`Permanently delete ${label}? This removes their account and login and cannot be undone.`)) return;
    setBusy(id);
    const res = await fetch('/api/admin/delete-customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    let j: { ok?: boolean; error?: string } = {};
    try { j = await res.json(); } catch { /* non-JSON error response */ }
    setBusy(null);
    if (!res.ok || !j.ok) { alert(j.error || `Could not delete (HTTP ${res.status}).`); return; }
    loadAccountApprovals();
  }

  // Pull new customer accounts that need approval: pending link requests plus
  // self-signups that have no business and no request yet.
  async function loadAccountApprovals() {
    const { data: reqs } = await supabase
      .from('business_link_requests')
      .select(`
        id, claimed_name, created_at,
        profile:profiles!business_link_requests_profile_id_fkey(id, full_name, email, phone),
        business:businesses!business_link_requests_business_id_fkey(id, name)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    const reqRows = ((reqs as any[]) || []).map((r) => ({
      ...r,
      profile: Array.isArray(r.profile) ? r.profile[0] || null : r.profile,
      business: Array.isArray(r.business) ? r.business[0] || null : r.business,
    })) as AccountReq[];
    setLinkReqs(reqRows);
    const reqProfileIds = new Set(reqRows.map((r) => r.profile?.id).filter(Boolean));

    const { data: custs } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, business_name, address, created_at')
      .eq('role', 'customer')
      .is('business_id', null)
      .is('imported_from_qb_customer_id', null)
      .order('created_at', { ascending: false });
    const unlinkedRows = ((custs as UnlinkedCustomer[]) || []).filter((c) => !reqProfileIds.has(c.id));
    setUnlinked(unlinkedRows);

    // Load document status + hold flag for everyone awaiting approval.
    const allIds = Array.from(new Set([...reqProfileIds, ...unlinkedRows.map((c) => c.id)])) as string[];
    if (allIds.length > 0) {
      const { data: docs } = await supabase
        .from('customer_documents')
        .select('customer_id, doc_type')
        .in('customer_id', allIds);
      const dmap = new Map<string, Set<string>>();
      for (const d of (docs as { customer_id: string; doc_type: string }[]) || []) {
        const s = dmap.get(d.customer_id) || new Set<string>();
        s.add(d.doc_type);
        dmap.set(d.customer_id, s);
      }
      setDocsByCustomer(dmap);
      const { data: holds } = await supabase.from('profiles').select('id, on_hold').in('id', allIds);
      setOnHoldIds(new Set(((holds as { id: string; on_hold: boolean }[]) || []).filter((h) => h.on_hold).map((h) => h.id)));
    } else {
      setDocsByCustomer(new Map());
      setOnHoldIds(new Set());
    }
  }

  // Doc checklist + hold/email controls shown on each awaiting-approval card.
  function awaitingExtras(profileId: string, email: string, name: string) {
    const present = docsByCustomer.get(profileId) || new Set<string>();
    const missing = DOC_DEFS.filter((d) => !present.has(d.key));
    const onHold = onHoldIds.has(profileId);
    return (
      <div className="w-full mt-2">
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {DOC_DEFS.map((d) => (
            <span
              key={d.key}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                present.has(d.key)
                  ? 'bg-green-50 text-green-800 border-green-200'
                  : 'bg-gray-100 text-gray-500 border-gray-200'
              }`}
            >
              {present.has(d.key) ? '✓ ' : '○ '}{d.label}
            </span>
          ))}
          {onHold && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-800 border border-orange-200">
              On hold
            </span>
          )}
        </div>
        {onHold ? (
          <button onClick={() => releaseHold(profileId)} className="text-[11px] text-gray-500 hover:underline">
            Remove hold
          </button>
        ) : (
          missing.length > 0 && (
            <button
              onClick={() => holdAndEmail(profileId, email, name, missing.map((d) => d.label))}
              className="text-[11px] text-orange-700 hover:underline"
            >
              Place on hold &amp; email about {missing.length} missing doc{missing.length === 1 ? '' : 's'}
            </button>
          )
        )}
      </div>
    );
  }

  async function approveLinkReq(id: string) {
    setBusy(id);
    const res = await fetch('/api/business/approve-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: id }),
    });
    const j = await res.json();
    setBusy(null);
    if (!j.ok) { alert(j.error || 'Approval failed.'); return; }
    loadAccountApprovals();
  }

  // Approve a self-signup with no business: create a business from their info
  // and link them as owner, which moves them into the Customers list and
  // unlocks their checkout.
  async function approveNewAccount(c: UnlinkedCustomer) {
    const name = (c.business_name || c.full_name || c.email || '').trim();
    if (!name) { alert('This account has no business name to create from.'); return; }
    setBusy(c.id);
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .insert({ name, address: c.address || null })
      .select('id')
      .single();
    if (bizErr || !biz) { setBusy(null); alert('Could not create business: ' + (bizErr?.message || 'unknown')); return; }
    const { error: upErr } = await supabase
      .from('profiles')
      .update({ business_id: biz.id, is_business_owner: true })
      .eq('id', c.id);
    setBusy(null);
    if (upErr) { alert('Business created but linking failed: ' + upErr.message); return; }
    loadAccountApprovals();
  }

  async function load() {
    setLoading(true);
    let q = supabase
      .from('customer_orders')
      .select(`
        id, status, invoice_number, delivery_address, notes, created_at, customer_id, sales_rep_id, submitted_by_id,
        customer_order_items(id),
        customer:profiles!customer_orders_customer_id_fkey(full_name, email, business_name, phone),
        sales_rep:profiles!customer_orders_sales_rep_id_fkey(full_name, email),
        submitted_by:profiles!customer_orders_submitted_by_id_fkey(full_name, email, role)
      `)
      .order('created_at', { ascending: false });

    if (statusFilter === 'open') {
      q = q.in('status', ['pending', 'invoiced']);
    } else if (statusFilter !== 'all') {
      q = q.eq('status', statusFilter);
    }

    const { data } = await q;
    const rows = (data as unknown as OrderRow[]) || [];
    setOrders(rows);
    setLoading(false);

    // Best-effort: pull auto-post failure notes for the loaded orders. If the
    // column hasn't been added yet, this query just errors and we show nothing.
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const { data: errRows, error: errErr } = await supabase
        .from('customer_orders').select('id, auto_post_error').in('id', ids);
      const m = new Map<string, string>();
      if (!errErr) {
        for (const r of (errRows as { id: string; auto_post_error: string | null }[]) || []) {
          if (r.auto_post_error) m.set(r.id, r.auto_post_error);
        }
      }
      setAutoErrors(m);
    } else {
      setAutoErrors(new Map());
    }
  }

  useEffect(() => { load(); }, [statusFilter]);
  useEffect(() => { loadAccountApprovals(); }, []);
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setMeRole(data?.role ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-semibold">Confirm</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
          >
            <option value="open">Open (pending + invoiced)</option>
            <option value="pending">Pending</option>
            <option value="invoiced">Invoiced</option>
            <option value="dispatched">Dispatched</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {(linkReqs.length > 0 || unlinked.length > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-5">
          <h2 className="font-semibold text-amber-900 mb-1">
            Customer accounts awaiting approval
            <span className="font-normal text-amber-800/70"> ({linkReqs.length + unlinked.length})</span>
          </h2>
          <p className="text-xs text-amber-900/80 mb-3">
            New signups. Approve to add them to your Customers list so they can place orders.
          </p>
          <div className="space-y-2">
            {linkReqs.map((r) => (
              <div key={r.id} className="bg-white border border-amber-200 rounded-md p-3 flex justify-between items-start gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.profile?.full_name || r.profile?.email || 'Unknown'}</div>
                  <div className="text-xs text-gray-600">{[r.profile?.email, r.profile?.phone].filter(Boolean).join(' · ')}</div>
                  <div className="text-xs text-amber-900 mt-1">Claiming: <span className="font-medium">{r.business?.name || r.claimed_name}</span></div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => approveLinkReq(r.id)} disabled={busy === r.id}
                    className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded hover:bg-brand-900 disabled:opacity-50 font-medium">
                    {busy === r.id ? 'Working…' : 'Approve'}
                  </button>
                  {meRole === 'master_admin' && r.profile?.id && (
                    <button onClick={() => deleteAccount(r.profile!.id, r.profile?.full_name || r.profile?.email || 'this account')}
                      disabled={busy === r.profile.id}
                      className="text-[11px] text-red-600 hover:text-red-800 hover:underline">
                      Delete
                    </button>
                  )}
                </div>
                {r.profile?.id && awaitingExtras(r.profile.id, r.profile.email || '', r.profile.full_name || r.profile.email || 'there')}
              </div>
            ))}
            {unlinked.map((c) => (
              <div key={c.id} className="bg-white border border-amber-200 rounded-md p-3 flex justify-between items-start gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{c.business_name || c.full_name || c.email}</div>
                  <div className="text-xs text-gray-600">{[c.full_name && c.business_name ? c.full_name : null, c.email, c.phone].filter(Boolean).join(' · ')}</div>
                  {c.address && <div className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">{c.address}</div>}
                  <div className="text-[11px] text-amber-800 mt-1">New account · not linked to a business yet</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => approveNewAccount(c)} disabled={busy === c.id}
                    className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded hover:bg-brand-900 disabled:opacity-50 font-medium">
                    {busy === c.id ? 'Working…' : 'Approve'}
                  </button>
                  {meRole === 'master_admin' && (
                    <button onClick={() => deleteAccount(c.id, c.business_name || c.full_name || c.email)}
                      disabled={busy === c.id}
                      className="text-[11px] text-red-600 hover:text-red-800 hover:underline">
                      Delete
                    </button>
                  )}
                </div>
                {awaitingExtras(c.id, c.email || '', c.business_name || c.full_name || c.email || 'there')}
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">No orders.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={`/admin/customer-orders/${o.id}`}
              className="px-4 py-3 flex justify-between items-center gap-2 hover:bg-gray-50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">
                    {o.customer?.business_name || o.customer?.full_name || o.customer?.email || 'Unknown'}
                  </span>
                  {statusBadge(o.status)}
                  {o.submitted_by_id && o.submitted_by_id !== o.customer_id && o.submitted_by?.role === 'salesman' && (
                    <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full border bg-indigo-50 text-indigo-800 border-indigo-200">
                      sales rep submitted
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {new Date(o.created_at).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                  {' · '}
                  {o.customer_order_items.length} item{o.customer_order_items.length === 1 ? '' : 's'}
                  {o.sales_rep && ` · Rep: ${o.sales_rep.full_name || o.sales_rep.email}`}
                  {(() => {
                    // Who put this order in — a sales rep on the customer's
                    // behalf, or the customer themselves. Shown on every order
                    // so it's clear who to ask if questions come up.
                    const placedBy =
                      o.submitted_by_id && o.submitted_by_id !== o.customer_id
                        ? o.submitted_by?.full_name || o.submitted_by?.email
                        : o.customer?.full_name || o.customer?.email;
                    return placedBy ? <> · Placed by {placedBy}</> : null;
                  })()}
                  {o.invoice_number && ` · Invoice ${o.invoice_number}`}
                </div>
                {/* Why an auto-invoice customer's order is sitting here instead
                    of going straight to the warehouse — the cause from the last
                    auto-post attempt, so you can fix it instead of guessing. */}
                {o.status === 'pending' && autoErrors.get(o.id) && (
                  <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                    Didn&apos;t auto-post: {autoErrors.get(o.id)}
                  </div>
                )}
              </div>
              <span className="text-gray-400 text-sm shrink-0">→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
