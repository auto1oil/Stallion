'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import CustomerDocuments from '@/components/CustomerDocuments';

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  business_name: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  business_id: string | null;
  is_business_owner: boolean;
  docs_required: boolean;
  tax_exempt_applicable: boolean;
  w9_applicable: boolean;
};
type OrderSummary = {
  id: string;
  status: string;
  created_at: string;
  invoice_number: string | null;
  item_count: number;
};

// Other profiles sharing the same business_id — the "team".
type TeamMember = {
  id: string;
  full_name: string | null;
  email: string;
  is_business_owner: boolean;
};

// An unredeemed invite for the team.
type PendingInvite = {
  id: string;
  invitee_email: string | null;
  invitee_role_label: string;
  token: string;
  expires_at: string;
};

// A customer-configured reorder reminder. The cron job (added later)
// computes next_fire_at and fires notifications to the team.
type Reminder = {
  id: string;
  kind: 'weekly' | 'biweekly' | 'monthly_day' | 'usage_based';
  day_of_week: number | null;
  day_of_month: number | null;
  active: boolean;
  next_fire_at: string | null;
  learned_interval_days: number | null;
};

const MAX_TEAM = 3;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Compute the next fire time given the schedule. Used client-side when
// the customer saves a reminder so they immediately see "Next reminder:".
function computeNextFire(kind: Reminder['kind'], day_of_week: number | null, day_of_month: number | null): Date | null {
  const now = new Date();
  if (kind === 'weekly' && day_of_week != null) {
    const next = new Date(now);
    next.setDate(now.getDate() + ((day_of_week + 7 - now.getDay()) % 7 || 7));
    next.setHours(9, 0, 0, 0);
    return next;
  }
  if (kind === 'biweekly' && day_of_week != null) {
    const next = new Date(now);
    next.setDate(now.getDate() + ((day_of_week + 14 - now.getDay()) % 14 || 14));
    next.setHours(9, 0, 0, 0);
    return next;
  }
  if (kind === 'monthly_day' && day_of_month != null) {
    const next = new Date(now.getFullYear(), now.getMonth(), day_of_month, 9, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next;
  }
  return null;
}

function describeReminder(r: Reminder): string {
  if (r.kind === 'weekly' && r.day_of_week != null)       return `Every ${DOW[r.day_of_week]}`;
  if (r.kind === 'biweekly' && r.day_of_week != null)     return `Every other ${DOW[r.day_of_week]}`;
  if (r.kind === 'monthly_day' && r.day_of_month != null) return `Day ${r.day_of_month} of each month`;
  if (r.kind === 'usage_based') {
    return r.learned_interval_days
      ? `Auto — every ~${r.learned_interval_days} days (learned)`
      : 'Auto — learning (place 3 orders first)';
  }
  return 'Reminder';
}

function statusLabel(s: string): string {
  return ({
    pending: 'Pending review',
    invoiced: 'Invoiced',
    dispatched: 'Out for delivery',
    cancelled: 'Cancelled',
  } as Record<string, string>)[s] || s;
}

export default function ShopAccountPage() {
  const supabase = createClient();
  const [me, setMe] = useState<Profile | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);

  // Reminder-modal state
  const [showReminder, setShowReminder] = useState(false);
  const [remKind, setRemKind] = useState<Reminder['kind']>('weekly');
  const [remDow, setRemDow] = useState<number>(2); // default Tuesday
  const [remDom, setRemDom] = useState<number>(15);
  const [remBusy, setRemBusy] = useState(false);
  const [remError, setRemError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ full_name: '', business_name: '', phone: '', address: '', city: '' });
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const [loading, setLoading] = useState(true);

  // Invite-modal state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'Owner' | 'Manager' | 'Accountant'>('Manager');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string } | null>(null);
  const [inviteError, setInviteError] = useState('');

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data: profile }, { data: ordersRows }] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, email, full_name, business_name, phone, address, city, business_id, is_business_owner, docs_required, tax_exempt_applicable, w9_applicable')
        .eq('id', user.id)
        .single(),
      supabase
        .from('customer_orders')
        .select('id, status, created_at, invoice_number, customer_order_items(id)')
        .eq('customer_id', user.id)
        .order('created_at', { ascending: false }),
    ]);
    const p = profile as Profile;
    setMe(p);
    setForm({
      full_name: p?.full_name || '',
      business_name: p?.business_name || '',
      phone: p?.phone || '',
      address: p?.address || '',
      city: p?.city || '',
    });
    setOrders(
      ((ordersRows as any[]) || []).map((o) => ({
        id: o.id,
        status: o.status,
        created_at: o.created_at,
        invoice_number: o.invoice_number,
        item_count: o.customer_order_items?.length || 0,
      })),
    );

    // Team + pending invites + reminders (only fetch if linked to a business).
    if (p?.business_id) {
      const [{ data: teamRows }, { data: inviteRows }, { data: reminderRows }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name, email, is_business_owner')
          .eq('business_id', p.business_id),
        supabase
          .from('business_invites')
          .select('id, invitee_email, invitee_role_label, token, expires_at')
          .eq('business_id', p.business_id)
          .is('accepted_at', null)
          .gt('expires_at', new Date().toISOString()),
        supabase
          .from('reorder_reminders')
          .select('id, kind, day_of_week, day_of_month, active, next_fire_at, learned_interval_days')
          .eq('business_id', p.business_id)
          .eq('active', true),
      ]);
      setTeam((teamRows as TeamMember[]) || []);
      setInvites((inviteRows as PendingInvite[]) || []);
      setReminders((reminderRows as Reminder[]) || []);
    }
    setLoading(false);
  }

  async function createReminder() {
    if (!me?.business_id) return;
    setRemBusy(true);
    setRemError('');
    const day_of_week = (remKind === 'weekly' || remKind === 'biweekly') ? remDow : null;
    const day_of_month = remKind === 'monthly_day' ? remDom : null;
    const nextFire = computeNextFire(remKind, day_of_week, day_of_month);
    const { error } = await supabase.from('reorder_reminders').insert({
      business_id: me.business_id,
      created_by_profile_id: me.id,
      kind: remKind,
      day_of_week,
      day_of_month,
      next_fire_at: nextFire ? nextFire.toISOString() : null,
    });
    setRemBusy(false);
    if (error) { setRemError(error.message); return; }
    setShowReminder(false);
    load();
  }

  async function deleteReminder(id: string) {
    if (!confirm('Delete this reminder?')) return;
    await supabase.from('reorder_reminders').delete().eq('id', id);
    load();
  }

  async function createInvite() {
    setInviteBusy(true);
    setInviteError('');
    setInviteResult(null);
    const res = await fetch('/api/business/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim() || null, role_label: inviteRole }),
    });
    const json = await res.json();
    setInviteBusy(false);
    if (!json.ok) {
      setInviteError(json.error || 'Could not create invite.');
      return;
    }
    const url = `${window.location.origin}/invite/${json.invite.token}`;
    setInviteResult({ url });
    setInviteEmail('');
    load();
  }

  async function revokeInvite(id: string) {
    if (!confirm('Revoke this invite link?')) return;
    await fetch(`/api/business/invite?id=${id}`, { method: 'DELETE' });
    load();
  }

  async function copyInviteLink(token: string) {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      alert('Invite link copied to clipboard.');
    } catch {
      prompt('Copy this invite link:', url);
    }
  }

  useEffect(() => { load(); }, []);

  async function saveProfile() {
    if (!me) return;
    setSaving(true);
    setSavedNote('');
    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: form.full_name.trim() || null,
        business_name: form.business_name.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
      })
      .eq('id', me.id);
    setSaving(false);
    if (error) {
      setSavedNote('Could not save: ' + error.message);
    } else {
      setSavedNote('Saved.');
      setEditing(false);
      load();
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  // For self-signup customers, the docs they must have on file. profile_sheet
  // is always required; W-9 and TC-721 depend on the per-customer flags.
  const requiredDocTypes: ('profile_sheet' | 'tax_exempt' | 'fein')[] | undefined = me?.docs_required
    ? [
        'profile_sheet',
        ...(me.w9_applicable ? (['fein'] as const) : []),
        ...(me.tax_exempt_applicable ? (['tax_exempt'] as const) : []),
      ]
    : undefined;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">My account</h1>

      {/* Documents — collapsed by default. Customers fill these in once and
          rarely need to revisit; admins still see them expanded on
          /admin/customers. */}
      {me && (
        <details open={!!me.docs_required} className="bg-white border border-gray-200 rounded-lg mb-6 group">
          <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between hover:bg-gray-50 rounded-lg">
            <span className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              My documents
            </span>
            <span className="text-xs text-gray-400 group-open:hidden">
              Profile sheet · TC-721 · W-9
            </span>
            <span className="text-xs text-gray-400 hidden group-open:inline">
              Hide
            </span>
          </summary>
          <div className="px-4 pb-4 pt-1 border-t border-gray-100">
            {me.docs_required && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
                These documents are required before you can place an order. Required items are
                marked with <span className="text-red-500">*</span>.
              </p>
            )}
            <CustomerDocuments customerId={me.id} requiredDocTypes={requiredDocTypes} />
          </div>
        </details>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Your info</h2>
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Business name</label>
              <input type="text" value={form.business_name}
                onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Your name</label>
              <input type="text" value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
              <input type="tel" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
              <input type="text" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="e.g. Lehi"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Delivery address</label>
              <textarea value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base resize-none" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setEditing(false); setSavedNote(''); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
              <button onClick={saveProfile} disabled={saving}
                className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {savedNote && <p className="text-sm text-gray-600">{savedNote}</p>}
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div><span className="text-gray-500">Business:</span> {me?.business_name || <span className="text-gray-400">not set</span>}</div>
            <div><span className="text-gray-500">Name:</span> {me?.full_name || <span className="text-gray-400">not set</span>}</div>
            <div><span className="text-gray-500">Email:</span> {me?.email}</div>
            <div><span className="text-gray-500">Phone:</span> {me?.phone || <span className="text-gray-400">not set</span>}</div>
            <div><span className="text-gray-500">City:</span> {me?.city || <span className="text-gray-400">not set</span>}</div>
            <div className="pt-1">
              <span className="text-gray-500">Address:</span>{' '}
              <span className="whitespace-pre-wrap">{me?.address || <span className="text-gray-400">not set</span>}</span>
            </div>
            <button onClick={() => setEditing(true)} className="mt-3 text-sm text-brand-700 font-medium hover:underline">
              Edit
            </button>
          </div>
        )}
      </div>

      {me?.business_id && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Team</h2>
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
            <p className="text-xs text-gray-500 mb-3">
              Up to {MAX_TEAM} people can share this account.
            </p>
            <ul className="space-y-1 mb-3">
              {team.map((m) => (
                <li key={m.id} className="text-sm flex justify-between items-center">
                  <span>
                    <span className="font-medium">{m.full_name || m.email}</span>
                    {m.is_business_owner && (
                      <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 bg-brand-50 text-brand-700 rounded">Owner</span>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">{m.email}</span>
                </li>
              ))}
              {invites.map((i) => (
                <li key={i.id} className="text-sm flex justify-between items-center text-gray-500 italic">
                  <span>
                    <span>{i.invitee_email || 'Pending invite'}</span>
                    <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded not-italic">
                      {i.invitee_role_label}
                    </span>
                  </span>
                  <span className="flex gap-2 text-xs not-italic">
                    <button onClick={() => copyInviteLink(i.token)} className="text-brand-700 hover:underline">Copy link</button>
                    {me.is_business_owner && (
                      <button onClick={() => revokeInvite(i.id)} className="text-red-600 hover:underline">Revoke</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {me.is_business_owner && team.length + invites.length < MAX_TEAM && (
              <button
                onClick={() => { setShowInvite(true); setInviteResult(null); setInviteError(''); }}
                className="text-sm text-brand-700 font-medium hover:underline"
              >
                + Invite teammate
              </button>
            )}
          </div>
        </>
      )}

      {me?.business_id && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Reorder reminders</h2>
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
            <p className="text-xs text-gray-500 mb-3">
              Get a nudge when it's time to reorder — we'll notify your team{' '}
              {reminders.some((r) => r.kind === 'usage_based') ? 'and your sales rep ' : ''}
              based on the schedule you pick.
            </p>
            {reminders.length === 0 ? (
              <p className="text-xs text-gray-400 italic mb-3">No reminders set up yet.</p>
            ) : (
              <ul className="space-y-1 mb-3">
                {reminders.map((r) => (
                  <li key={r.id} className="flex justify-between items-center text-sm">
                    <div>
                      <div className="font-medium">{describeReminder(r)}</div>
                      {r.next_fire_at && (
                        <div className="text-xs text-gray-500">
                          Next: {new Date(r.next_fire_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                        </div>
                      )}
                    </div>
                    <button onClick={() => deleteReminder(r.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => { setShowReminder(true); setRemError(''); }}
              className="text-sm text-brand-700 font-medium hover:underline"
            >
              + Add reminder
            </button>
          </div>
        </>
      )}

      {/* Reorder reminder modal */}
      {showReminder && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-lg font-semibold mb-3">Add a reorder reminder</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Frequency</label>
                <select value={remKind} onChange={(e) => setRemKind(e.target.value as Reminder['kind'])}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white">
                  <option value="weekly">Every week</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="monthly_day">Once a month (day of month)</option>
                  <option value="usage_based">Auto — based on my ordering pattern</option>
                </select>
              </div>

              {(remKind === 'weekly' || remKind === 'biweekly') && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Day of week</label>
                  <select value={remDow} onChange={(e) => setRemDow(Number(e.target.value))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white">
                    {DOW.map((name, i) => <option key={i} value={i}>{name}</option>)}
                  </select>
                </div>
              )}

              {remKind === 'monthly_day' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Day of month</label>
                  <input type="number" min={1} max={31} value={remDom}
                         onChange={(e) => setRemDom(Number(e.target.value))}
                         className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
                  <p className="text-[11px] text-gray-500 mt-1">
                    If the month is shorter (e.g. day 31 in February), we&apos;ll use the last day.
                  </p>
                </div>
              )}

              {remKind === 'usage_based' && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                  <p className="text-xs text-amber-900">
                    After 3 orders we'll figure out how often you typically reorder and
                    notify you on that cadence. Your sales rep will get a heads-up too.
                  </p>
                </div>
              )}

              {remError && <p className="text-sm text-red-600">{remError}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowReminder(false)}
                        className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
                <button onClick={createReminder} disabled={remBusy}
                        className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50 font-medium">
                  {remBusy ? 'Saving…' : 'Add reminder'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-lg font-semibold mb-3">Invite a teammate</h2>
            {inviteResult ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">
                  Invite created. Share this link with your teammate — they&apos;ll use it
                  to sign up and join your business.
                </p>
                <div className="bg-gray-50 border border-gray-200 rounded p-2 break-all text-xs font-mono">
                  {inviteResult.url}
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(inviteResult.url).catch(() => {}); }}
                  className="w-full py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
                >
                  Copy link
                </button>
                <button
                  onClick={() => { setShowInvite(false); setInviteResult(null); }}
                  className="w-full py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Their email (optional)</label>
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                         placeholder="manager@business.com"
                         className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Saved for your records — you&apos;ll need to share the link yourself.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'Owner' | 'Manager' | 'Accountant')}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white">
                    <option>Owner</option>
                    <option>Manager</option>
                    <option>Accountant</option>
                  </select>
                </div>
                {inviteError && <p className="text-sm text-red-600">{inviteError}</p>}
                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={() => setShowInvite(false)}
                          className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
                  <button onClick={createInvite} disabled={inviteBusy}
                          className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
                    {inviteBusy ? 'Creating…' : 'Create invite link'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Order history</h2>
      {orders.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">
          No orders yet. <Link href="/shop" className="text-brand-700 hover:underline">Start shopping →</Link>
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={`/shop/order/${o.id}`}
              className="px-4 py-3 flex justify-between items-center hover:bg-gray-50"
            >
              <div className="text-sm">
                <div className="font-medium">
                  {new Date(o.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </div>
                <div className="text-xs text-gray-500">
                  {o.item_count} item{o.item_count === 1 ? '' : 's'}
                  {o.invoice_number && ` · Invoice ${o.invoice_number}`}
                </div>
              </div>
              <span className="text-xs text-gray-700">{statusLabel(o.status)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
