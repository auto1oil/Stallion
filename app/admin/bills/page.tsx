'use client';

// Vendor bills review queue. Bills arrive here (manual entry, upload, or — once
// wired — a forwarded-invoice email), an admin reviews vendor/date/amount, then
// pushes to QuickBooks as a Bill. Nothing posts to QB without the Push button.

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { vendorKey, lineKey } from '@/lib/bill-map';

type LineItem = {
  description: string;
  qty: number | null;
  unit_cost: number | null;
  amount: number;
  qb_item_name: string | null;
};

type Bill = {
  id: string;
  status: 'pending' | 'approved' | 'pushed' | 'rejected';
  vendor_name: string | null;
  invoice_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  memo: string | null;
  source: 'manual' | 'upload' | 'email';
  source_email_from: string | null;
  attachment_path: string | null;
  parse_status: string | null;
  qb_doc_number: string | null;
  qb_bill_id: string | null;
  paid: boolean;
  paid_at: string | null;
  line_items: LineItem[] | null;
  created_at: string;
};

type Vendor = { id: string; name: string; sender: string | null; active: boolean };

const STATUS_STYLE: Record<Bill['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  pushed: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-200 text-gray-600',
};

const EMPTY_NEW = { vendor_name: '', invoice_number: '', bill_date: '', due_date: '', total_amount: '', memo: '' };

export default function BillsPage() {
  const supabase = createClient();
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'due' | 'confirm'>('due');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_NEW });
  const [file, setFile] = useState<File | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState<string | null>(null);
  const [syncingItems, setSyncingItems] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [itemNames, setItemNames] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('vendor_bills')
      .select('id, status, vendor_name, invoice_number, bill_date, due_date, total_amount, memo, source, source_email_from, attachment_path, parse_status, qb_doc_number, qb_bill_id, paid, paid_at, line_items, created_at')
      .order('created_at', { ascending: false });
    if (error) setErr(error.message);
    else setBills((data || []) as Bill[]);
    setLoading(false);
  }, [supabase]);

  const loadVendors = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    const master = me?.role === 'master_admin';
    setIsMaster(master);
    if (!master) return;
    const { data } = await supabase
      .from('bill_vendors')
      .select('id, name, sender, active')
      .order('name');
    setVendors((data || []) as Vendor[]);
  }, [supabase]);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from('inventory_items')
      .select('qb_name')
      .eq('active', true)
      .order('qb_name');
    setItemNames((data || []).map((r) => (r as { qb_name: string }).qb_name));
  }, [supabase]);

  // Pull open A/P from QuickBooks on load (lightweight, no email) so the Due
  // list populates without anyone hunting for a button. Surfaces failures.
  const syncAp = useCallback(async () => {
    try {
      const res = await fetch('/api/bills/sync-ap', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'QuickBooks bill sync failed'); return; }
      if (json.error) setErr(`QuickBooks bill sync: ${json.failed} of ${json.open} failed — ${json.error}`);
      await load();
    } catch { /* ignore — manual Sync bills still available */ }
  }, [load]);

  useEffect(() => {
    void (async () => {
      await Promise.all([load(), loadVendors(), loadItems()]);
      void syncAp();
    })();
  }, [load, loadVendors, loadItems, syncAp]);

  // Persist a bill's line_items array (local + db).
  async function saveLines(bill: Bill, lines: LineItem[]) {
    const { error } = await supabase.from('vendor_bills').update({ line_items: lines }).eq('id', bill.id);
    if (error) { setErr(error.message); return; }
    setBills((prev) => prev.map((b) => (b.id === bill.id ? { ...b, line_items: lines } : b)));
  }
  // Add a blank product line the admin can fill in + match (for bills the AI
  // couldn't itemize, or manual entries).
  async function addLine(bill: Bill) {
    const lines = [...(bill.line_items || []), { description: '', qty: null, unit_cost: null, amount: 0, qb_item_name: null }];
    await saveLines(bill, lines);
  }
  async function removeLine(bill: Bill, idx: number) {
    await saveLines(bill, (bill.line_items || []).filter((_, i) => i !== idx));
  }
  async function updateLineField(bill: Bill, idx: number, field: 'description' | 'qty' | 'unit_cost' | 'amount', raw: string) {
    const lines = (bill.line_items || []).map((l, i) => {
      if (i !== idx) return l;
      if (field === 'description') return { ...l, description: raw };
      return { ...l, [field]: raw === '' ? null : Number(raw) };
    });
    await saveLines(bill, lines);
  }

  // Map a bill line to an inventory item: persist on the bill, apply to any
  // sibling lines with the same wording, and remember it for this vendor so
  // future bills auto-map.
  async function setLineMapping(bill: Bill, idx: number, qbItemName: string) {
    const value = qbItemName.trim() || null;
    const desc = bill.line_items?.[idx]?.description ?? '';
    const lines = (bill.line_items || []).map((l) =>
      l.description === desc ? { ...l, qb_item_name: value } : l,
    );
    const { error } = await supabase.from('vendor_bills').update({ line_items: lines }).eq('id', bill.id);
    if (error) { setErr(error.message); return; }
    setBills((prev) => prev.map((b) => (b.id === bill.id ? { ...b, line_items: lines } : b)));
    if (value) {
      await supabase.from('bill_line_map').upsert(
        { vendor_key: vendorKey(bill.vendor_name), match_text: lineKey(desc), qb_item_name: value },
        { onConflict: 'vendor_key,match_text' },
      );
    }
  }

  // Master-admin vendor-allowlist actions.
  async function saveVendorSender(id: string, sender: string) {
    const value = sender.trim() || null;
    const { error } = await supabase.from('bill_vendors').update({ sender: value }).eq('id', id);
    if (error) { setErr(error.message); return; }
    setVendors((prev) => prev.map((v) => (v.id === id ? { ...v, sender: value } : v)));
  }
  async function toggleVendorActive(id: string, active: boolean) {
    const { error } = await supabase.from('bill_vendors').update({ active }).eq('id', id);
    if (error) { setErr(error.message); return; }
    setVendors((prev) => prev.map((v) => (v.id === id ? { ...v, active } : v)));
  }
  async function addVendor(name: string, sender: string) {
    const { data, error } = await supabase
      .from('bill_vendors')
      .insert({ name: name.trim(), sender: sender.trim() || null })
      .select('id, name, sender, active')
      .single();
    if (error) { setErr(error.message); return; }
    setVendors((prev) => [...prev, data as Vendor].sort((a, b) => a.name.localeCompare(b.name)));
  }
  async function deleteVendor(id: string) {
    if (!confirm('Remove this vendor from the allowlist?')) return;
    const { error } = await supabase.from('bill_vendors').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    setVendors((prev) => prev.filter((v) => v.id !== id));
  }

  // Three lenses. Unpaid (default) = posted A/P we owe (in QuickBooks),
  // soonest due first. Approve = bills pulled from email / entered by hand that
  // still need review + pushing. Paid = settled.
  const isUnpaid = (b: Bill) => b.status === 'pushed' && !b.paid;
  const isPending = (b: Bill) => b.status === 'pending' || b.status === 'approved';
  const visible = bills.filter((b) => {
    if (filter === 'due') return isUnpaid(b);
    if (filter === 'confirm') return isPending(b);
    return true;
  });
  if (filter === 'due') {
    // Soonest due first; bills with no due date sink to the bottom.
    visible.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  }

  const unpaidBills = bills.filter(isUnpaid);
  const pendingBills = bills.filter(isPending);
  const totalOwed = unpaidBills.reduce((s, b) => s + (b.total_amount || 0), 0);
  const todayISO = new Date().toISOString().slice(0, 10);

  // Duplicate detection: an unpushed bill whose vendor + invoice # already
  // matches one we've pushed/paid is a re-send. (QuickBooks-only duplicates —
  // entered straight in QB — are caught authoritatively when you press Push.)
  const dupKey = (b: Bill) => `${vendorKey(b.vendor_name)}|${(b.invoice_number || '').trim().toLowerCase()}`;
  const pushedKeys = new Set(
    bills.filter((b) => (b.status === 'pushed' || b.paid) && b.invoice_number).map(dupKey),
  );
  const isDuplicate = (b: Bill) =>
    b.status !== 'pushed' && !!b.invoice_number && pushedKeys.has(dupKey(b));

  async function patch(id: string, fields: Partial<Bill>) {
    const { error } = await supabase.from('vendor_bills').update(fields).eq('id', id);
    if (error) { setErr(error.message); return false; }
    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, ...fields } : b)));
    return true;
  }

  async function setPaid(id: string, paid: boolean) {
    const { data: { user } } = await supabase.auth.getUser();
    const fields = { paid, paid_at: paid ? new Date().toISOString() : null, paid_by: paid ? user?.id ?? null : null };
    const { error } = await supabase.from('vendor_bills').update(fields).eq('id', id);
    if (error) { setErr(error.message); return; }
    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, paid, paid_at: fields.paid_at } : b)));
  }

  async function push(id: string) {
    setBusyId(id); setErr(null);
    try {
      const res = await fetch('/api/bills/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Push failed'); return; }
      setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: 'pushed', qb_bill_id: json.qbBillId, qb_doc_number: json.qbDocNumber } : b)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Push failed');
    } finally {
      setBusyId(null);
    }
  }

  async function openAttachment(path: string) {
    const { data, error } = await supabase.storage.from('vendor-bills').createSignedUrl(path, 120);
    if (error || !data) { setErr(error?.message || 'Could not open file'); return; }
    window.open(data.signedUrl, '_blank');
  }

  async function addBill(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true); setErr(null);
    try {
      let attachment_path: string | null = null;
      if (file) {
        const path = `${new Date().getFullYear()}/${crypto.randomUUID()}-${file.name}`;
        const up = await supabase.storage.from('vendor-bills').upload(path, file);
        if (up.error) { setErr(up.error.message); setAdding(false); return; }
        attachment_path = up.data.path;
      }
      const { error } = await supabase.from('vendor_bills').insert({
        source: file ? 'upload' : 'manual',
        status: 'pending',
        vendor_name: form.vendor_name || null,
        invoice_number: form.invoice_number || null,
        bill_date: form.bill_date || null,
        due_date: form.due_date || null,
        total_amount: form.total_amount ? Number(form.total_amount) : null,
        memo: form.memo || null,
        attachment_path,
      });
      if (error) { setErr(error.message); setAdding(false); return; }
      setForm({ ...EMPTY_NEW }); setFile(null);
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function syncItems() {
    setSyncingItems(true); setErr(null); setPollMsg(null);
    try {
      const res = await fetch('/api/quickbooks/import-items', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Item sync failed'); return; }
      setPollMsg(json.imported > 0
        ? `Imported ${json.imported} new item${json.imported === 1 ? '' : 's'} from QuickBooks (${json.total} total).`
        : `Items up to date (${json.total} in QuickBooks).`);
      await loadItems();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Item sync failed');
    } finally {
      setSyncingItems(false);
    }
  }

  async function pollEmail() {
    setPolling(true); setErr(null); setPollMsg(null);
    try {
      const res = await fetch('/api/bills/poll', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Email check failed'); return; }
      const emailMsg = json.created > 0
        ? `Pulled ${json.created} new bill${json.created === 1 ? '' : 's'} from email`
        : `No new bills from email — scanned ${json.scanned ?? 0} with attachments, ${json.matched ?? 0} from approved vendors${json.duplicate ? `, ${json.duplicate} already filed` : ''}`;
      // When nothing matched, show the senders we saw so the allowlist can be fixed.
      if ((json.created ?? 0) === 0 && (json.matched ?? 0) === 0 && json.senders?.length) {
        setErr(`No approved-vendor emails matched. Senders seen: ${json.senders.join(', ')}`);
      }
      if (json.errors?.length) setErr(`Email errors: ${json.errors.slice(0, 3).join(' | ')}`);
      const ap = json.ap;
      if (ap?.error) {
        setErr(`QuickBooks bill sync couldn't save (${ap.failed} of ${ap.open} failed): ${ap.error}`);
      }
      const apMsg = ap
        ? `; ${ap.imported} imported / ${ap.open} open QuickBooks bill${ap.open === 1 ? '' : 's'}${ap.closed ? `, ${ap.closed} marked paid` : ''}`
        : '';
      setPollMsg(`${emailMsg}${apMsg}.`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Email check failed');
    } finally {
      setPolling(false);
    }
  }

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return (
    <div>
      {/* Inventory item names, shared by every line's "map item" input. */}
      <datalist id="bill-item-names">
        {itemNames.map((n) => <option key={n} value={n} />)}
      </datalist>

      <div className="flex items-start justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold">Vendor bills</h1>
        <div className="flex gap-2 shrink-0">
          {/* Products sync (for bill line→item mapping) only matters on the
              Approve tab where bills get pushed; keep it out of the way. */}
          {filter === 'confirm' && (
            <button onClick={syncItems} disabled={syncingItems}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 disabled:opacity-50 whitespace-nowrap">
              {syncingItems ? 'Syncing…' : 'Sync products'}
            </button>
          )}
          <button onClick={pollEmail} disabled={polling}
            className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white disabled:opacity-50 whitespace-nowrap font-medium">
            {polling ? 'Syncing…' : '↻ Sync bills'}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Unpaid vendor bills and when they’re due. Recent bills emailed to the mailbox are pulled in
        automatically each hour; admins are alerted the day before and on the due date.
      </p>

      {/* Total owed — the headline number for the unpaid list. */}
      {filter === 'due' && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 flex items-baseline justify-between">
          <span className="text-sm text-gray-500">Total due</span>
          <span className="text-2xl font-semibold">
            {money(totalOwed)}
            <span className="text-sm font-normal text-gray-400 ml-2">
              {unpaidBills.length} bill{unpaidBills.length === 1 ? '' : 's'}
            </span>
          </span>
        </div>
      )}

      {pollMsg && (
        <div className="mb-3 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">
          {pollMsg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {err}
        </div>
      )}

      {/* Known-vendor allowlist — master admins only, intake config so it lives
          with the Approve tab. Controls which senders the poller treats as bills. */}
      {isMaster && filter === 'confirm' && (
        <VendorAllowlist
          vendors={vendors}
          onSaveSender={saveVendorSender}
          onToggleActive={toggleVendorActive}
          onAdd={addVendor}
          onDelete={deleteVendor}
        />
      )}

      {/* Add a bill manually / by upload — intake, so it lives on Confirm. */}
      {filter === 'confirm' && (
      <form onSubmit={addBill} className="mb-5 rounded-lg border border-gray-200 bg-white p-3">
        <div className="text-sm font-medium mb-2">Add a bill</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <input className="border rounded px-2 py-1.5 text-sm" placeholder="Vendor"
            value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })} />
          <input className="border rounded px-2 py-1.5 text-sm" placeholder="Invoice #"
            value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })} />
          <input className="border rounded px-2 py-1.5 text-sm" placeholder="Amount" inputMode="decimal"
            value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} />
          <label className="text-xs text-gray-500 flex flex-col">Bill date
            <input type="date" className="border rounded px-2 py-1 text-sm"
              value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} />
          </label>
          <label className="text-xs text-gray-500 flex flex-col">Due date
            <input type="date" className="border rounded px-2 py-1 text-sm"
              value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </label>
          <input className="border rounded px-2 py-1.5 text-sm" placeholder="Memo"
            value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
        </div>
        <div className="flex items-center justify-between mt-2">
          <input type="file" accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
          <button type="submit" disabled={adding}
            className="px-3 py-1.5 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50">
            {adding ? 'Adding…' : 'Add to queue'}
          </button>
        </div>
      </form>
      )}

      {/* Sub-tabs — Due (posted A/P owed) · Confirm (from email, needs a person)
          · Paid */}
      <div className="flex gap-2 mb-3">
        {([
          ['due', 'Due', unpaidBills.length],
          ['confirm', 'Confirm', pendingBills.length],
        ] as const).map(([key, label, count]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`px-3 py-1 text-sm rounded-md border ${
              filter === key ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300'
            }`}>
            {label}
            {count > 0 && (
              <span className={`ml-1.5 text-xs ${key === 'confirm' ? 'inline-flex items-center justify-center min-w-[16px] h-4 px-1 font-bold bg-red-500 text-white rounded-full align-middle' : 'text-gray-500'}`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          {filter === 'due'
            ? 'No bills due. Tap “Sync bills” to pull your open bills from QuickBooks.'
            : filter === 'confirm'
              ? 'Nothing to confirm. Bills pulled from email land here for a person to review.'
              : 'Nothing here.'}
        </p>
      ) : (
        <div className="space-y-3">
          {visible.map((b) => {
            const editable = b.status === 'pending' || b.status === 'approved';
            return (
              <div key={b.id} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {b.paid ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800">paid</span>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[b.status]}`}>{b.status}</span>
                    )}
                    {!b.paid && b.due_date && (() => {
                      const days = Math.round((new Date(b.due_date + 'T00:00:00').getTime() - new Date(todayISO + 'T00:00:00').getTime()) / 86400000);
                      const cls = days < 0 ? 'bg-red-100 text-red-800'
                        : days === 0 ? 'bg-red-100 text-red-800'
                        : days <= 3 ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-600';
                      const label = days < 0 ? `${-days}d overdue` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days}d`;
                      return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
                    })()}
                    {isDuplicate(b) && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800" title={`Invoice #${b.invoice_number} already entered`}>
                        ⚠ already entered
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400">
                    {b.source}{b.source_email_from ? ` · ${b.source_email_from}` : ''}
                    {b.parse_status === 'failed' ? ' · parse failed' : ''}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <input className="border rounded px-2 py-1.5 text-sm" placeholder="Vendor" disabled={!editable}
                    defaultValue={b.vendor_name ?? ''} onBlur={(e) => patch(b.id, { vendor_name: e.target.value || null })} />
                  <input className="border rounded px-2 py-1.5 text-sm" placeholder="Invoice #" disabled={!editable}
                    defaultValue={b.invoice_number ?? ''} onBlur={(e) => patch(b.id, { invoice_number: e.target.value || null })} />
                  <input className="border rounded px-2 py-1.5 text-sm" placeholder="Amount" inputMode="decimal" disabled={!editable}
                    defaultValue={b.total_amount ?? ''} onBlur={(e) => patch(b.id, { total_amount: e.target.value ? Number(e.target.value) : null })} />
                  <label className="text-xs text-gray-500 flex flex-col">Bill date
                    <input type="date" className="border rounded px-2 py-1 text-sm" disabled={!editable}
                      defaultValue={b.bill_date ?? ''} onBlur={(e) => patch(b.id, { bill_date: e.target.value || null })} />
                  </label>
                  <label className="text-xs text-gray-500 flex flex-col">Due date
                    <input type="date" className="border rounded px-2 py-1 text-sm" disabled={!editable}
                      defaultValue={b.due_date ?? ''} onBlur={(e) => patch(b.id, { due_date: e.target.value || null })} />
                  </label>
                  <input className="border rounded px-2 py-1.5 text-sm" placeholder="Memo" disabled={!editable}
                    defaultValue={b.memo ?? ''} onBlur={(e) => patch(b.id, { memo: e.target.value || null })} />
                </div>

                {/* Line items → inventory-item mapping. On editable (Confirm)
                    bills the lines + amounts are editable and you can add lines;
                    each maps to an inventory item (remembered per vendor) and
                    posts to QB as an item-based line (inventory + COGS). */}
                {(editable || (b.line_items && b.line_items.length > 0)) && (
                  <div className="mt-3 border-t border-gray-100 pt-2">
                    <div className="text-xs font-medium text-gray-500 mb-1">Lines → inventory item</div>
                    <div className="space-y-1">
                      {(b.line_items || []).map((l, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          {editable ? (
                            <>
                              <input
                                defaultValue={l.description}
                                placeholder="description"
                                onBlur={(e) => { if (e.target.value !== l.description) updateLineField(b, i, 'description', e.target.value); }}
                                className="flex-1 min-w-0 border rounded px-2 py-1 text-xs"
                              />
                              <input
                                defaultValue={l.qty ?? ''} placeholder="qty" inputMode="decimal"
                                onBlur={(e) => updateLineField(b, i, 'qty', e.target.value)}
                                className="w-14 border rounded px-2 py-1 text-xs text-right shrink-0"
                              />
                              <input
                                defaultValue={l.amount ?? ''} placeholder="amount" inputMode="decimal"
                                onBlur={(e) => updateLineField(b, i, 'amount', e.target.value)}
                                className="w-20 border rounded px-2 py-1 text-xs text-right shrink-0"
                              />
                            </>
                          ) : (
                            <>
                              <span className="flex-1 min-w-0 truncate" title={l.description}>{l.description}</span>
                              <span className="text-xs text-gray-400 w-28 text-right shrink-0">
                                {l.qty != null ? l.qty.toLocaleString() : '—'}{l.unit_cost != null ? ` × $${l.unit_cost}` : ''}
                              </span>
                              <span className="text-xs w-20 text-right shrink-0">{money(l.amount)}</span>
                            </>
                          )}
                          <input
                            list="bill-item-names"
                            disabled={!editable}
                            defaultValue={l.qb_item_name ?? ''}
                            placeholder="map item…"
                            onBlur={(e) => { if ((e.target.value.trim() || null) !== l.qb_item_name) setLineMapping(b, i, e.target.value); }}
                            className={`border rounded px-2 py-1 text-xs w-44 shrink-0 ${l.qb_item_name ? '' : 'border-amber-300 bg-amber-50'}`}
                          />
                          {editable && (
                            <button onClick={() => removeLine(b, i)} className="text-red-500 text-xs px-1 hover:text-red-700 shrink-0">✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                    {editable && (
                      <button onClick={() => addLine(b)} className="mt-2 text-xs text-brand-700 hover:underline">
                        + Add product line
                      </button>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{money(b.total_amount)}</span>
                    {b.attachment_path && (
                      <button onClick={() => openAttachment(b.attachment_path!)} className="text-brand-600 underline">
                        View file
                      </button>
                    )}
                    {b.status === 'pushed' && b.qb_doc_number && (
                      <span className="text-green-700 text-xs">QB Bill #{b.qb_doc_number}</span>
                    )}
                    {b.paid && b.paid_at && (
                      <span className="text-green-700 text-xs">Paid {new Date(b.paid_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {editable && (() => {
                      const unmapped = (b.line_items || []).filter((l) => l.amount && !l.qb_item_name).length;
                      const dup = isDuplicate(b);
                      const blockReason = dup ? `Invoice #${b.invoice_number} is already entered — reject it instead`
                        : unmapped > 0 ? 'Map every line to an inventory item first' : '';
                      return (
                        <>
                          {unmapped > 0 && !dup && (
                            <span className="text-xs text-amber-600">{unmapped} line{unmapped === 1 ? '' : 's'} to map</span>
                          )}
                          <button onClick={() => patch(b.id, { status: 'rejected' })}
                            className="px-3 py-1.5 text-sm rounded-md border border-gray-300">
                            Reject
                          </button>
                          <button onClick={() => push(b.id)} disabled={busyId === b.id || unmapped > 0 || dup}
                            title={blockReason}
                            className="px-3 py-1.5 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50">
                            {busyId === b.id ? 'Pushing…' : 'Push to QuickBooks'}
                          </button>
                        </>
                      );
                    })()}
                    {/* Pushed bills get their paid status from QuickBooks
                        automatically (synced hourly) — no manual button. Only
                        bills that never went to QB keep a manual toggle. */}
                    {b.status !== 'rejected' && !b.qb_bill_id && (
                      b.paid ? (
                        <button onClick={() => setPaid(b.id, false)}
                          className="px-3 py-1.5 text-sm rounded-md border border-gray-300">
                          Mark unpaid
                        </button>
                      ) : (
                        <button onClick={() => setPaid(b.id, true)}
                          className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white">
                          Mark paid
                        </button>
                      )
                    )}
                    {!b.paid && b.qb_bill_id && (
                      <span className="text-xs text-gray-400">paid status via QuickBooks</span>
                    )}
                  </div>
                  {b.status === 'rejected' && (
                    <button onClick={() => patch(b.id, { status: 'pending' })}
                      className="px-3 py-1.5 text-sm rounded-md border border-gray-300">
                      Restore
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Master-admin-only allowlist of vendors whose emails count as bills. Each
// vendor's `sender` (email or domain) is what the poller matches against; a
// vendor with no sender yet is "named but not wired" and won't pull anything.
function VendorAllowlist({ vendors, onSaveSender, onToggleActive, onAdd, onDelete }: {
  vendors: Vendor[];
  onSaveSender: (id: string, sender: string) => void;
  onToggleActive: (id: string, active: boolean) => void;
  onAdd: (name: string, sender: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSender, setNewSender] = useState('');
  const wired = vendors.filter((v) => v.active && v.sender).length;

  return (
    <div className="mb-5 rounded-lg border border-gray-200 bg-white p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between">
        <span className="text-sm font-medium">
          Approved vendors <span className="text-gray-400 font-normal">· {vendors.length} · {wired} with email</span>
        </span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-3">
            The email poller only files a bill when the sender matches an active vendor below. Put each
            vendor’s email address or domain in the Sender box — open one of their bills and copy the part
            of the “From” address (e.g. <span className="font-mono">loves.com</span> or
            <span className="font-mono"> billing@bradhall.com</span>). Until at least one sender is set, the
            inbox stays open (any attachment becomes a draft bill).
          </p>

          <div className="space-y-2">
            {vendors.map((v) => (
              <div key={v.id} className="flex items-center gap-2">
                <input type="checkbox" checked={v.active} title="Active"
                  onChange={(e) => onToggleActive(v.id, e.target.checked)} className="w-4 h-4" />
                <span className="text-sm w-32 shrink-0 truncate" title={v.name}>{v.name}</span>
                <input
                  className="flex-1 border rounded px-2 py-1 text-sm font-mono"
                  placeholder="sender email or domain…"
                  defaultValue={v.sender ?? ''}
                  onBlur={(e) => { if ((e.target.value.trim() || null) !== v.sender) onSaveSender(v.id, e.target.value); }}
                />
                {!v.sender && <span className="text-[10px] text-amber-600 whitespace-nowrap">not wired</span>}
                <button onClick={() => onDelete(v.id)} className="text-red-600 text-xs px-1 hover:text-red-800">✕</button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            <input className="w-32 shrink-0 border rounded px-2 py-1 text-sm" placeholder="Vendor name"
              value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className="flex-1 border rounded px-2 py-1 text-sm font-mono" placeholder="sender email or domain (optional)"
              value={newSender} onChange={(e) => setNewSender(e.target.value)} />
            <button
              onClick={() => { if (newName.trim()) { onAdd(newName, newSender); setNewName(''); setNewSender(''); } }}
              disabled={!newName.trim()}
              className="px-3 py-1 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50 whitespace-nowrap">
              Add vendor
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
