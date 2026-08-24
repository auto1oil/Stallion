'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// A purchase-order log. The blank entry card sits at the TOP, pre-filled with
// the next auto PO number; the issuer is the logged-in admin (recorded
// automatically). Saved POs list below (newest first). POs can be edited (shows
// "edited") or canceled — canceling never removes the row, it just shades it
// gray. Admin-only (RLS).

type PO = {
  id: string;
  po_number: number;
  po_date: string;                 // yyyy-mm-dd
  amount: number | null;
  description: string | null;
  job_invoice: string | null;
  approved_by: string | null;
  created_by_name: string | null;
  edited_at: string | null;
  canceled_at: string | null;
  vendor_name: string | null;
  vendor_qb_id: string | null;
  qb_bill_id: string | null;
  qb_bill_doc: string | null;
  qb_pushed_at: string | null;
};

// First PO number when the log is empty. Change here (and it flows to the
// display + the stored number) if the business wants to start elsewhere.
const PO_START = 1000;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function todayStr(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Initials from a full name: "Cody Roberts" → "CR", "Coen" → "CO".
function initialsFrom(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmtDate(d: string): string {
  // yyyy-mm-dd → m/d/yyyy without pulling in a timezone shift.
  const [y, m, day] = (d || '').split('-');
  if (!y || !m || !day) return d || '';
  return `${Number(m)}/${Number(day)}/${y}`;
}

export default function AdminPoPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<PO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [needsMigration, setNeedsMigration] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState('');
  const [myInitials, setMyInitials] = useState('');

  // Blank entry card (no "approved by" — that's the logged-in admin).
  const [date, setDate] = useState(todayStr());
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [jobInvoice, setJobInvoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Vendor typeahead for the new PO (needed to push a bill to QuickBooks).
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vendorQuery, setVendorQuery] = useState('');
  const [vendorResults, setVendorResults] = useState<{ id: string; name: string }[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);
  const [vendorErr, setVendorErr] = useState('');

  // "New vendor" form (creates the vendor in QuickBooks).
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [nvName, setNvName] = useState('');
  const [nvContact, setNvContact] = useState('');
  const [nvPhone, setNvPhone] = useState('');
  const [nvEmail, setNvEmail] = useState('');
  const [nvAddress, setNvAddress] = useState('');
  const [nvBusy, setNvBusy] = useState(false);
  const [nvErr, setNvErr] = useState('');

  // Default QuickBooks expense account these bills post to.
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [acctId, setAcctId] = useState('');
  const [pushBusy, setPushBusy] = useState<string | null>(null); // po id currently pushing

  // Inline edit state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eDate, setEDate] = useState('');
  const [eAmount, setEAmount] = useState('');
  const [eDescription, setEDescription] = useState('');
  const [eJobInvoice, setEJobInvoice] = useState('');
  const [eVendorId, setEVendorId] = useState('');
  const [eVendorName, setEVendorName] = useState('');
  const [eVendorQuery, setEVendorQuery] = useState('');
  const [eVendorResults, setEVendorResults] = useState<{ id: string; name: string }[]>([]);
  const [rowBusy, setRowBusy] = useState(false);

  const nextNumber = useMemo(
    () => (rows.length ? Math.max(...rows.map((r) => r.po_number)) + 1 : PO_START),
    [rows],
  );

  const load = useCallback(async () => {
    const FULL = 'id, po_number, po_date, amount, description, job_invoice, approved_by, created_by_name, edited_at, canceled_at, vendor_name, vendor_qb_id, qb_bill_id, qb_bill_doc, qb_pushed_at';
    const BASE = 'id, po_number, po_date, amount, description, job_invoice, approved_by, created_by_name';
    const r1 = await supabase
      .from('purchase_orders').select(FULL).order('po_number', { ascending: false });
    let data: Partial<PO>[] | null = r1.data as Partial<PO>[] | null;
    let error = r1.error;
    // 42703 = undefined_column: the edited_at/canceled_at migration hasn't been
    // applied yet. Fall back to the base columns so existing POs still show and
    // the numbering keeps counting up — a pending migration must never blank the
    // list or reset the PO number back to the start.
    if (error && (error as { code?: string }).code === '42703') {
      const r2 = await supabase.from('purchase_orders').select(BASE).order('po_number', { ascending: false });
      data = r2.data as Partial<PO>[] | null; error = r2.error;
      setNeedsMigration(true);
    } else {
      setNeedsMigration(false);
    }
    if (error) { setLoadError(error.message); setRows([]); }
    else {
      setLoadError('');
      setRows((data || []).map((r) => ({
        edited_at: null, canceled_at: null, vendor_name: null, vendor_qb_id: null,
        qb_bill_id: null, qb_bill_doc: null, qb_pushed_at: null, ...r,
      })) as PO[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setMeId(user?.id || null);
      if (user) {
        const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
        const name = (data?.full_name || '').trim();
        setMeName(name);
        setMyInitials(initialsFrom(name));
      }
      await load();
    })();
  }, [supabase, load]);

  // Expense-account list + the saved default (app_settings, admin-readable).
  useEffect(() => {
    fetch('/api/quickbooks/expense-accounts').then((r) => r.json()).then((j) => {
      if (j.ok) setAccounts(j.accounts);
    }).catch(() => {});
    supabase.from('app_settings').select('value').eq('key', 'po_expense_account_id').maybeSingle()
      .then(({ data }) => setAcctId((data?.value as string) || ''));
  }, [supabase]);

  async function saveDefaultAccount(id: string) {
    setAcctId(id);
    const name = accounts.find((a) => a.id === id)?.name || '';
    await supabase.from('app_settings').upsert([
      { key: 'po_expense_account_id', value: id },
      { key: 'po_expense_account_name', value: name },
    ], { onConflict: 'key' });
  }

  // Vendor search — debounced as you type.
  useEffect(() => {
    const q = vendorQuery.trim();
    if (q.length < 2) { setVendorResults([]); setVendorErr(''); return; }
    setVendorSearching(true);
    const t = setTimeout(async () => {
      try {
        const j = await fetch(`/api/quickbooks/vendors?q=${encodeURIComponent(q)}`).then((r) => r.json());
        if (j.ok) { setVendorResults(j.vendors); setVendorErr(''); }
        else { setVendorResults([]); setVendorErr(j.error || 'Search failed'); }
      } catch { setVendorResults([]); setVendorErr('Network error'); }
      finally { setVendorSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [vendorQuery]);

  async function createNewVendor() {
    if (!nvName.trim()) { setNvErr('Vendor name is required.'); return; }
    setNvBusy(true); setNvErr('');
    const j = await fetch('/api/quickbooks/vendors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nvName.trim(), contactName: nvContact.trim(), phone: nvPhone.trim(), email: nvEmail.trim(), address: nvAddress.trim() }),
    }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Network error' }));
    setNvBusy(false);
    if (!j.ok) { setNvErr(j.error || 'Could not create vendor.'); return; }
    setVendorId(j.vendor.id); setVendorName(j.vendor.name);
    setShowNewVendor(false);
    setNvName(''); setNvContact(''); setNvPhone(''); setNvEmail(''); setNvAddress(''); setVendorQuery('');
  }

  // Push a PO into QuickBooks as a Bill (create first time, update after edits).
  async function pushBill(poId: string) {
    setPushBusy(poId);
    const j = await fetch('/api/admin/po/push-bill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ po_id: poId }),
    }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Network error' }));
    setPushBusy(null);
    if (!j.ok) { alert(j.error || 'Could not push to QuickBooks.'); return; }
    await load();
  }

  async function save() {
    setSaveError('');
    const amt = amount.trim() === '' ? null : Number(amount);
    if (amt !== null && !Number.isFinite(amt)) { setSaveError('Amount must be a number.'); return; }
    if (amt === null && !description.trim()) {
      setSaveError('Enter at least an amount or a description.');
      return;
    }
    setSaving(true);
    // Compute the number here and retry if another admin grabbed it first.
    let attempt = 0;
    while (attempt < 3) {
      const current = attempt === 0
        ? nextNumber
        : (rows.length ? Math.max(...rows.map((r) => r.po_number)) + 1 : PO_START);
      const { data: inserted, error } = await supabase.from('purchase_orders').insert({
        po_number: current,
        po_date: date || todayStr(),
        amount: amt,
        description: description.trim() || null,
        job_invoice: jobInvoice.trim() || null,
        approved_by: myInitials || null,   // the logged-in admin, recorded automatically
        created_by: meId,
        created_by_name: meName || null,
        vendor_name: vendorName || null,
        vendor_qb_id: vendorId || null,
      }).select('id').single();
      if (!error) {
        setAmount(''); setDescription(''); setJobInvoice(''); setDate(todayStr());
        setVendorId(''); setVendorName(''); setVendorQuery('');
        // Auto-create the QuickBooks bill when a vendor + amount are present.
        if (inserted?.id && vendorName && amt) {
          await pushBill(inserted.id as string);
        } else {
          await load();
        }
        setSaving(false);
        return;
      }
      // 23505 = unique_violation on po_number → someone used it; recompute.
      if ((error as { code?: string }).code === '23505') { await load(); attempt++; continue; }
      setSaveError(error.message);
      setSaving(false);
      return;
    }
    setSaveError('Could not get a free PO number — please try again.');
    setSaving(false);
  }

  function startEdit(r: PO) {
    setEditingId(r.id);
    setEDate(r.po_date || todayStr());
    setEAmount(r.amount != null ? String(r.amount) : '');
    setEDescription(r.description || '');
    setEJobInvoice(r.job_invoice || '');
    setEVendorId(r.vendor_qb_id || '');
    setEVendorName(r.vendor_name || '');
    setEVendorQuery(''); setEVendorResults([]);
  }

  // Vendor search inside the edit form.
  useEffect(() => {
    const q = eVendorQuery.trim();
    if (q.length < 2) { setEVendorResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const j = await fetch(`/api/quickbooks/vendors?q=${encodeURIComponent(q)}`).then((r) => r.json());
        setEVendorResults(j.ok ? j.vendors : []);
      } catch { setEVendorResults([]); }
    }, 350);
    return () => clearTimeout(t);
  }, [eVendorQuery]);

  async function saveEdit(r: PO) {
    const amt = eAmount.trim() === '' ? null : Number(eAmount);
    if (amt !== null && !Number.isFinite(amt)) { alert('Amount must be a number.'); return; }
    setRowBusy(true);
    const { error } = await supabase.from('purchase_orders').update({
      po_date: eDate || todayStr(),
      amount: amt,
      description: eDescription.trim() || null,
      job_invoice: eJobInvoice.trim() || null,
      vendor_name: eVendorName || null,
      vendor_qb_id: eVendorId || null,
      edited_at: new Date().toISOString(),
    }).eq('id', r.id);
    setRowBusy(false);
    if (error) { alert(error.message); return; }
    setEditingId(null);
    await load();
  }

  async function cancelPo(r: PO) {
    if (!confirm(`Cancel PO #${r.po_number}? It stays on the list, shaded gray — not deleted.`)) return;
    const { error } = await supabase.from('purchase_orders')
      .update({ canceled_at: new Date().toISOString() }).eq('id', r.id);
    if (error) { alert(error.message); return; }
    await load();
  }

  async function restorePo(r: PO) {
    const { error } = await supabase.from('purchase_orders')
      .update({ canceled_at: null }).eq('id', r.id);
    if (error) { alert(error.message); return; }
    await load();
  }

  const fieldLabel = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1';
  const inputCls = 'w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Purchase Orders</h1>
        <p className="text-sm text-gray-500">
          The next PO number is filled in for you and the PO is recorded under
          {myInitials ? <> your account (<span className="font-medium">{myInitials}</span>)</> : ' your account'}.
          Complete the box below and press <span className="font-medium">Save</span>.
        </p>
      </div>

      {/* Entry card — at the top, with the next PO number front and center. */}
      <div className="bg-brand-50 border border-brand-200 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">New PO</span>
          <span className="text-2xl font-bold text-brand-700 leading-none">#{nextNumber}</span>
        </div>

        {/* Compact fields across the top. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className={fieldLabel}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={fieldLabel}>Amount</label>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={fieldLabel}>Job / Invoice</label>
            <input
              placeholder="Job or invoice #"
              value={jobInvoice}
              onChange={(e) => setJobInvoice(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {/* Vendor — required to push the PO to QuickBooks as a bill. */}
        <div>
          <label className={fieldLabel}>Vendor <span className="text-gray-400 normal-case">(for the QuickBooks bill)</span></label>
          {vendorName ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-900">{vendorName}</span>
              <button onClick={() => { setVendorId(''); setVendorName(''); }} className="text-xs text-gray-400 hover:text-red-600">change</button>
            </div>
          ) : showNewVendor ? (
            <div className="rounded-md border border-brand-200 bg-white p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">New vendor</span>
                <button onClick={() => { setShowNewVendor(false); setNvErr(''); }} className="text-xs text-gray-400 hover:text-gray-700">cancel</button>
              </div>
              <input value={nvName} onChange={(e) => setNvName(e.target.value)} placeholder="Vendor name *" className={inputCls} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={nvContact} onChange={(e) => setNvContact(e.target.value)} placeholder="Contact name" className={inputCls} />
                <input value={nvPhone} onChange={(e) => setNvPhone(e.target.value)} placeholder="Phone" className={inputCls} />
                <input value={nvEmail} onChange={(e) => setNvEmail(e.target.value)} placeholder="Email" className={inputCls} />
              </div>
              <textarea value={nvAddress} onChange={(e) => setNvAddress(e.target.value)} placeholder="Address" rows={2} className={`${inputCls} resize-y`} />
              {nvErr && <p className="text-xs text-red-600">{nvErr}</p>}
              <div className="flex justify-end">
                <button onClick={createNewVendor} disabled={nvBusy}
                  className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-3 py-1.5 disabled:opacity-50">
                  {nvBusy ? 'Creating…' : 'Create vendor'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <input value={vendorQuery} onChange={(e) => setVendorQuery(e.target.value)}
                placeholder="Search QuickBooks vendors… (leave blank to skip the bill)" className={inputCls} autoComplete="off" />
              <div className="mt-1">
                {vendorSearching && <p className="text-xs text-gray-400 px-1">Searching…</p>}
                {!vendorSearching && vendorErr && <p className="text-xs text-red-600 px-1">{vendorErr}</p>}
                {vendorResults.length > 0 && (
                  <ul className="border border-gray-200 rounded-md divide-y divide-gray-100 max-h-40 overflow-auto bg-white">
                    {vendorResults.map((v) => (
                      <li key={v.id}>
                        <button onClick={() => { setVendorId(v.id); setVendorName(v.name); setVendorResults([]); setVendorQuery(''); }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-brand-50">{v.name}</button>
                      </li>
                    ))}
                  </ul>
                )}
                <button onClick={() => { setShowNewVendor(true); setNvName(vendorQuery.trim()); }}
                  className="mt-1 text-xs text-brand-700 hover:underline">+ New vendor</button>
              </div>
            </>
          )}
        </div>

        {/* Description spans the full width and grows as needed. */}
        <div>
          <label className={fieldLabel}>Description</label>
          <textarea
            rows={3}
            placeholder="What this PO is for…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputCls} resize-y min-h-[3rem]`}
          />
        </div>

        {/* QuickBooks expense account these bills post to (set once). */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className="uppercase tracking-wide font-semibold">Bill posts to</span>
          <select value={acctId} onChange={(e) => saveDefaultAccount(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-800">
            <option value="">QuickBooks default expense account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {vendorName && <span className="text-brand-700">Saving this PO will create a QuickBooks bill for {vendorName}.</span>}
        </div>

        <div className="flex items-center justify-end gap-3">
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 disabled:opacity-50 whitespace-nowrap"
          >
            {saving ? 'Saving…' : `Save PO #${nextNumber}`}
          </button>
        </div>
      </div>

      {needsMigration && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          Almost set up: the Edit/Cancel database update hasn&apos;t been run yet, so those
          buttons won&apos;t work until it is. Your saved POs are safe and still listed below.
        </div>
      )}
      {loadError && !needsMigration && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {loadError}
        </div>
      )}

      {/* Saved POs — newest first. Canceled ones stay, shaded gray. */}
      <div className="space-y-2">
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-gray-400">No purchase orders yet.</p>
        )}
        {!loading && rows.map((r) => {
          const canceled = !!r.canceled_at;
          const edited = !canceled && !!r.edited_at;
          const editing = editingId === r.id;

          if (editing) {
            return (
              <div key={r.id} className="bg-white border border-brand-300 rounded-lg shadow-sm p-4 space-y-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-bold text-brand-700">#{r.po_number}</span>
                  <span className="text-xs uppercase tracking-wide text-gray-400">Editing</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label className={fieldLabel}>Date</label>
                    <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={fieldLabel}>Amount</label>
                    <input inputMode="decimal" placeholder="0.00" value={eAmount} onChange={(e) => setEAmount(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className={fieldLabel}>Job / Invoice</label>
                    <input placeholder="Job or invoice #" value={eJobInvoice} onChange={(e) => setEJobInvoice(e.target.value)} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className={fieldLabel}>Vendor <span className="text-gray-400 normal-case">(for the QuickBooks bill)</span></label>
                  {eVendorName ? (
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-900">{eVendorName}</span>
                      <button onClick={() => { setEVendorId(''); setEVendorName(''); }} className="text-xs text-gray-400 hover:text-red-600">change</button>
                    </div>
                  ) : (
                    <>
                      <input value={eVendorQuery} onChange={(e) => setEVendorQuery(e.target.value)} placeholder="Search QuickBooks vendors…" className={inputCls} autoComplete="off" />
                      {eVendorResults.length > 0 && (
                        <ul className="mt-1 border border-gray-200 rounded-md divide-y divide-gray-100 max-h-40 overflow-auto bg-white">
                          {eVendorResults.map((v) => (
                            <li key={v.id}>
                              <button onClick={() => { setEVendorId(v.id); setEVendorName(v.name); setEVendorResults([]); setEVendorQuery(''); }}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-brand-50">{v.name}</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <label className={fieldLabel}>Description</label>
                  <textarea rows={3} value={eDescription} onChange={(e) => setEDescription(e.target.value)} className={`${inputCls} resize-y min-h-[3rem]`} />
                </div>
                <div className="flex items-center justify-end gap-3">
                  {r.qb_bill_id && <span className="text-xs text-gray-400 mr-auto">Saved changes won&apos;t hit QuickBooks until you press <span className="font-medium">Update in QB</span> on the PO.</span>}
                  <button onClick={() => setEditingId(null)} className="text-sm text-gray-500 hover:text-gray-800">Cancel</button>
                  <button
                    onClick={() => saveEdit(r)}
                    disabled={rowBusy}
                    className="rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
                  >
                    {rowBusy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={r.id}
              className={[
                'border rounded-lg shadow-sm px-4 py-3',
                canceled ? 'bg-gray-100 border-gray-200'
                  : edited ? 'bg-amber-50 border-amber-200'   // shaded so edited POs stand out
                  : 'bg-white border-gray-200',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className={['text-base font-bold', canceled ? 'text-gray-400 line-through' : 'text-brand-700'].join(' ')}>
                  #{r.po_number}
                </span>
                {canceled && (
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-200 rounded px-1.5 py-0.5">
                    Canceled
                  </span>
                )}
                {!canceled && r.edited_at && (
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                    edited {fmtDate(r.edited_at.slice(0, 10))}
                  </span>
                )}
                <span className={['text-sm whitespace-nowrap', canceled ? 'text-gray-400' : 'text-gray-500'].join(' ')}>
                  {fmtDate(r.po_date)}
                </span>
                <span className={['text-sm font-semibold whitespace-nowrap', canceled ? 'text-gray-400' : 'text-gray-900'].join(' ')}>
                  {r.amount != null ? money.format(r.amount) : '—'}
                </span>
                {r.job_invoice && (
                  <span className={['text-sm whitespace-nowrap', canceled ? 'text-gray-400' : 'text-gray-600'].join(' ')}>
                    <span className="text-gray-400">Job/Inv:</span> {r.job_invoice}
                  </span>
                )}
                {r.approved_by && (
                  <span
                    className={['text-sm whitespace-nowrap', canceled ? 'text-gray-400' : 'text-gray-600'].join(' ')}
                    title={r.created_by_name || undefined}
                  >
                    <span className="text-gray-400">By:</span> {r.approved_by}
                  </span>
                )}
                {r.vendor_name && (
                  <span className={['text-sm whitespace-nowrap', canceled ? 'text-gray-400' : 'text-gray-600'].join(' ')}>
                    <span className="text-gray-400">Vendor:</span> {r.vendor_name}
                  </span>
                )}
                {r.qb_bill_id && !canceled && (
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5"
                    title={r.qb_pushed_at ? `Pushed ${fmtDate(r.qb_pushed_at.slice(0, 10))}` : undefined}>
                    QB Bill{r.qb_bill_doc ? ` #${r.qb_bill_doc}` : ''}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {canceled ? (
                    <button onClick={() => restorePo(r)} className="text-xs text-gray-500 hover:text-brand-700">Restore</button>
                  ) : (
                    <>
                      {r.vendor_name && (
                        <button onClick={() => pushBill(r.id)} disabled={pushBusy === r.id}
                          className="text-xs text-brand-700 hover:underline disabled:opacity-50 whitespace-nowrap">
                          {pushBusy === r.id ? 'Pushing…' : r.qb_bill_id ? 'Update in QB' : 'Push to QB'}
                        </button>
                      )}
                      <button onClick={() => startEdit(r)} className="text-xs text-gray-500 hover:text-brand-700">Edit</button>
                      <button onClick={() => cancelPo(r)} className="text-xs text-gray-400 hover:text-red-600">Cancel</button>
                    </>
                  )}
                </span>
              </div>
              {r.description && (
                <p className={['mt-1.5 text-sm whitespace-pre-wrap break-words', canceled ? 'text-gray-400' : 'text-gray-800'].join(' ')}>
                  {r.description}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!loading && rows.length > 0 && (
        <p className="text-xs text-gray-400">{rows.length} PO{rows.length === 1 ? '' : 's'} on record.</p>
      )}
    </div>
  );
}
