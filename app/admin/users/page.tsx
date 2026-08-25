'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import AddUserPanel from '@/components/AddUserPanel';

type Role = 'admin' | 'driver' | 'contractor' | 'funder' | 'hauler' | 'master_admin' | 'customer' | 'office' | 'mechanic' | 'labor';

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  phone: string | null;
  // Optional contact email shown on quotes (falls back to login email).
  contact_email: string | null;
  // Counties this user covers. Customers requesting a
  // visit see only users whose territory includes their county. Empty
  // list = unrestricted.
  territory_counties: string[] | null;
  // QuickBooks Class for this user (drives P&L-by-Class per rep).
  qb_class: string | null;
  // Which hauling company a 'hauler' login belongs to. Null for everyone
  // else — it is what scopes a hauler to their own fleet and loads.
  hauler_id: string | null;
};

const roleBadgeClass: Record<Role, string> = {
  admin: 'bg-brand-50 text-brand-900',
  master_admin: 'bg-brand-50 text-brand-900',
  contractor: 'bg-emerald-100 text-emerald-900',
  funder: 'bg-indigo-100 text-indigo-900',
  hauler: 'bg-teal-100 text-teal-900',
  driver: 'bg-gray-100 text-gray-700',
  customer: 'bg-gray-50 text-gray-500',
  office: 'bg-blue-100 text-blue-800',
  mechanic: 'bg-amber-100 text-amber-800',
  labor: 'bg-purple-100 text-purple-800',
};

// Counties the business serves. Match QuickBooks/customer profile values
// case-insensitively when filtering reps.
const COUNTIES = ['Utah County', 'Salt Lake County', 'Davis County', 'Weber County'] as const;

export default function UsersPage() {
  const supabase = createClient();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  // Per-user pending changes to territory_counties, applied on save.
  const [pendingCounties, setPendingCounties] = useState<Record<string, string[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  // Add-user form

  // Used by the role editor below to attach a hauler login to its company.
  const [haulers, setHaulers] = useState<{ id: string; name: string }[]>([]);

  async function load() {
    setLoading(true);
    // Hide customers from this list — they're managed in /admin/customers.
    const { data } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, phone, contact_email, territory_counties, qb_class, hauler_id')
      .neq('role', 'customer')
      .order('full_name');
    setUsers((data as Profile[]) || []);
    const { data: hs } = await supabase
      .from('haulers').select('id, name').eq('active', true).order('name');
    setHaulers((hs as { id: string; name: string }[]) || []);
    setPendingCounties({});
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // QuickBooks class list (for mapping each user to their class).
  const [qbClasses, setQbClasses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/quickbooks/classes').then((r) => r.json()).then((j) => {
      if (j.ok) setQbClasses(j.classes as { id: string; name: string }[]);
    }).catch(() => {});
  }, []);
  async function setQbClass(userId: string, qbClass: string | null) {
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, qb_class: qbClass } : u)));
    await supabase.from('profiles').update({ qb_class: qbClass }).eq('id', userId);
  }

  // Fill each staff member's QuickBooks Class by matching their name to a class
  // (e.g. "Jed Smith" -> class "JED"). Skips anyone who already has one set.
  const [matching, setMatching] = useState(false);
  async function autoMatchClasses() {
    setMatching(true);
    try {
      for (const u of users) {
        if (u.qb_class || u.role === 'customer') continue;
        const full = (u.full_name || '').toLowerCase().trim();
        const first = full.split(/\s+/)[0] || '';
        const hit = qbClasses.find((c) => {
          const cn = c.name.toLowerCase().trim();
          return cn === full || (!!first && (cn === first || cn.split(/[\s:]+/).includes(first)));
        });
        if (hit) await setQbClass(u.id, hit.name);
      }
    } finally {
      setMatching(false);
    }
  }

  async function saveBasic(p: Profile) {
    await supabase.from('profiles').update({
      full_name: p.full_name,
      role: p.role,
      // Only a hauler login carries a company; changing away from the role
      // clears it so a stale link can't outlive the role that needed it.
      hauler_id: p.role === 'hauler' ? (p.hauler_id || null) : null,
      phone: p.phone ? p.phone.trim() : null,
      contact_email: p.contact_email ? p.contact_email.trim() : null,
    }).eq('id', p.id);
    setEditing(null);
    load();
  }

  async function saveCounties(userId: string, counties: string[]) {
    setSavingId(userId);
    await supabase
      .from('profiles')
      .update({ territory_counties: counties })
      .eq('id', userId);
    setSavingId(null);
    setPendingCounties((p) => { const { [userId]: _drop, ...rest } = p; return rest; });
    load();
  }

  // Confirm a staff member's login email when they're stuck on "Email not
  // confirmed" (the Supabase confirmation email never reached them).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  async function confirmLogin(userId: string) {
    setConfirmingId(userId);
    try {
      const res = await fetch('/api/admin/confirm-customer-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: userId }),
      });
      const j = await res.json();
      alert(j.ok ? 'Login confirmed — they can sign in now.' : `Could not confirm: ${j.error || 'unknown'}`);
    } catch (e: any) {
      alert(`Could not confirm: ${e?.message || 'network'}`);
    } finally {
      setConfirmingId(null);
    }
  }

  // Set a new temporary password for a user when they're locked out. We show
  // the temp password to hand over (mail isn't reliable); they change it on
  // next sign-in.
  const [resettingId, setResettingId] = useState<string | null>(null);
  async function resetPassword(userId: string, label: string) {
    if (!confirm(`Reset the password for ${label}? This sets a new temporary password you'll give them.`)) return;
    setResettingId(userId);
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      const j = await res.json();
      if (j.ok) {
        navigator.clipboard?.writeText(`Temp password: ${j.password}`).catch(() => {});
        alert(`New temporary password for ${label}:\n\n${j.password}\n\n(Copied to clipboard. They'll set their own on next sign-in.)`);
      } else {
        alert(`Could not reset password: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      alert(`Could not reset password: ${e?.message || 'network'}`);
    } finally {
      setResettingId(null);
    }
  }

  function toggleCounty(userId: string, current: string[], county: string) {
    const next = current.includes(county)
      ? current.filter((c) => c !== county)
      : [...current, county];
    setPendingCounties((p) => ({ ...p, [userId]: next }));
  }

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-2xl font-semibold">Users</h1>
          {qbClasses.length > 0 && (
            <button
              onClick={autoMatchClasses}
              disabled={matching}
              className="px-3 py-1.5 text-xs rounded-md bg-brand-700 text-white hover:bg-brand-900 disabled:opacity-60 font-medium"
              title="Fill each user's QuickBooks Class by matching their name to your QuickBooks classes (skips ones already set)."
            >
              {matching ? 'Matching…' : '↻ Auto-match QuickBooks classes'}
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Click a user to assign which counties they cover. Empty = unrestricted.
          A user's <strong>QuickBooks Class</strong> stamps the invoices raised
          against their work.
        </p>
        <div className="mt-3">
          <AddUserPanel onAdded={load} />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {users.map((u) => {
            const isExpanded = expandedId === u.id;
            const isEditing = editing?.id === u.id;
            const current = pendingCounties[u.id] ?? u.territory_counties ?? [];
            return (
              <div key={u.id}>
                {/* Row header — click to expand the territory editor. */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : u.id)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between gap-3 flex-wrap"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">
                      {u.full_name || <span className="text-gray-400 italic">No name</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {u.email}{u.phone ? ` · ${u.phone}` : ''}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadgeClass[u.role] || roleBadgeClass.driver}`}>
                    {u.role}
                  </span>
                  <div className="text-right shrink-0 min-w-[140px]">
                    {(() => {
                      const n = u.territory_counties?.length ?? 0;
                      if (n === 0 || n === COUNTIES.length) {
                        return <span className="text-xs text-gray-500">All counties</span>;
                      }
                      return (
                        <span className="text-xs text-gray-700">
                          {n} of {COUNTIES.length} counties
                        </span>
                      );
                    })()}
                  </div>
                  <span className="text-gray-400 text-sm">{isExpanded ? '▾' : '▸'}</span>
                </button>

                {isExpanded && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-3">
                    {/* QuickBooks class — tags this user's invoice lines so
                        QuickBooks' P&L by Class reports their gross profit. */}
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
                        QuickBooks class
                      </label>
                      <select
                        value={u.qb_class || ''}
                        onChange={(e) => setQbClass(u.id, e.target.value || null)}
                        className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white w-full max-w-[260px]"
                      >
                        <option value="">— None —</option>
                        {/* Keep the saved value selectable even if the list hasn't loaded. */}
                        {u.qb_class && !qbClasses.some((c) => c.name === u.qb_class) && (
                          <option value={u.qb_class}>{u.qb_class}</option>
                        )}
                        {qbClasses.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                      <p className="text-[11px] text-gray-400 mt-1">
                        Fuel lines use “{u.qb_class ? `${u.qb_class} FUEL` : '<class> FUEL'}” automatically.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                        Approved areas
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {COUNTIES.map((county) => {
                          const checked = current.includes(county);
                          return (
                            <label
                              key={county}
                              className={`flex items-center gap-2 px-3 py-2 border rounded-md text-sm cursor-pointer ${
                                checked ? 'bg-brand-50 border-brand-500' : 'bg-white border-gray-300 hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCounty(u.id, current, county)}
                                className="w-4 h-4"
                              />
                              <span>{county}</span>
                            </label>
                          );
                        })}
                      </div>
                      {pendingCounties[u.id] !== undefined && (
                        <div className="mt-2">
                          <button
                            onClick={() => saveCounties(u.id, pendingCounties[u.id])}
                            disabled={savingId === u.id}
                            className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
                          >
                            {savingId === u.id ? 'Saving…' : 'Save territory'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Fix a stuck staff login — confirms their email so they
                        can sign in if "Email not confirmed" is blocking them,
                        or reset their password if they're locked out. */}
                    <div className="flex items-center justify-between gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 flex-wrap">
                      <span className="text-xs text-blue-900">Locked out?</span>
                      <div className="flex gap-2">
                        <button onClick={() => confirmLogin(u.id)} disabled={confirmingId === u.id}
                          className="px-3 py-1 text-xs rounded-md bg-blue-600 text-white whitespace-nowrap disabled:opacity-50">
                          {confirmingId === u.id ? 'Confirming…' : 'Confirm login'}
                        </button>
                        <button onClick={() => resetPassword(u.id, u.full_name || u.email)} disabled={resettingId === u.id}
                          className="px-3 py-1 text-xs rounded-md bg-amber-600 text-white whitespace-nowrap disabled:opacity-50">
                          {resettingId === u.id ? 'Resetting…' : 'Reset password'}
                        </button>
                      </div>
                    </div>

                    <details className="bg-white border border-gray-200 rounded">
                      <summary className="px-3 py-2 cursor-pointer text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50 rounded">
                        Edit name / role / contact info
                      </summary>
                      <div className="px-3 pb-3 pt-2 border-t border-gray-100">
                        {isEditing ? (
                          <div className="space-y-2">
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Name</label>
                              <input
                                type="text"
                                value={editing.full_name || ''}
                                onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Phone (SMS summaries + printed on quotes)</label>
                              <input
                                type="tel"
                                value={editing.phone || ''}
                                placeholder="(801) 555-1234"
                                onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Contact email for quotes <span className="text-gray-400 normal-case">(leave blank to use login email {editing.email})</span></label>
                              <input
                                type="email"
                                value={editing.contact_email || ''}
                                placeholder={editing.email}
                                onChange={(e) => setEditing({ ...editing, contact_email: e.target.value })}
                                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-600 mb-1">Role</label>
                              <select
                                value={editing.role}
                                onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}
                                className="px-2 py-1.5 border border-gray-300 rounded text-sm"
                              >
                                <option value="driver">Driver / crew</option>
                                <option value="office">Office</option>
                                <option value="contractor">Contractor</option>
                                <option value="funder">Funder</option>
                                <option value="hauler">Hauler</option>
                                <option value="admin">Admin</option>
                                <option value="mechanic">Mechanic</option>
                                <option value="labor">Labor</option>
                                {editing.role === 'master_admin' && (
                                  <option value="master_admin">Master admin</option>
                                )}
                              </select>
                            </div>
                            {editing.role === 'hauler' && (
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">Hauling company</label>
                                <select
                                  value={editing.hauler_id || ''}
                                  onChange={(e) => setEditing({ ...editing, hauler_id: e.target.value || null })}
                                  className="px-2 py-1.5 border border-gray-300 rounded text-sm"
                                >
                                  <option value="">— Pick a company —</option>
                                  {haulers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                                </select>
                              </div>
                            )}
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => saveBasic(editing)} className="px-3 py-1 text-sm bg-brand-700 text-white rounded hover:bg-brand-900">Save</button>
                              <button onClick={() => setEditing(null)} className="px-3 py-1 text-sm border border-gray-300 rounded">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => setEditing(u)} className="text-sm text-brand-700 hover:underline">
                            Edit
                          </button>
                        )}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            );
          })}
          {users.length === 0 && (
            <p className="px-4 py-6 text-center text-gray-500 text-sm">No users yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
