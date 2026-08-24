// QuickBooks Bills + Vendors — mirrors the patterns in lib/quickbooks.ts
// (reuses qbFetch for auth/refresh). Used by the vendor-bill review queue to
// push an approved bill into QuickBooks as a Bill against a matched Vendor.

import type { SupabaseClient } from '@supabase/supabase-js';
import { qbFetch } from './quickbooks';

export type QBVendor = { Id: string; DisplayName: string };

// Escape a value for the Intuit query language (single quotes are backslash-
// escaped). Keeps a vendor name like "O'Reilly" from breaking the query.
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findVendorByName(name: string, db?: SupabaseClient): Promise<QBVendor | null> {
  const query = `select Id, DisplayName from Vendor where DisplayName = '${esc(name)}'`;
  const res = await qbFetch<{ QueryResponse?: { Vendor?: QBVendor[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
    undefined,
    db,
  );
  return res.QueryResponse?.Vendor?.[0] ?? null;
}

export async function findOrCreateVendor(name: string, db?: SupabaseClient): Promise<QBVendor> {
  const existing = await findVendorByName(name, db);
  if (existing) return existing;
  const res = await qbFetch<{ Vendor: QBVendor }>(
    `/vendor`,
    { method: 'POST', body: JSON.stringify({ DisplayName: name }) },
    db,
  );
  return res.Vendor;
}

// Create a new QuickBooks vendor with contact details (from the PO "New vendor"
// form). Returns an existing vendor with the same name instead of duplicating.
export async function createVendor(
  opts: { name: string; contactName?: string; phone?: string; email?: string; address?: string },
  db?: SupabaseClient,
): Promise<QBVendor> {
  const name = (opts.name || '').trim();
  if (!name) throw new Error('Vendor name is required.');
  const existing = await findVendorByName(name, db);
  if (existing) return existing;

  const body: Record<string, unknown> = { DisplayName: name, CompanyName: name };
  const contact = (opts.contactName || '').trim();
  if (contact) {
    const parts = contact.split(/\s+/);
    body.GivenName = parts[0];
    if (parts.length > 1) body.FamilyName = parts.slice(1).join(' ');
  }
  if (opts.phone?.trim()) body.PrimaryPhone = { FreeFormNumber: opts.phone.trim() };
  if (opts.email?.trim()) body.PrimaryEmailAddr = { Address: opts.email.trim() };
  if (opts.address?.trim()) body.BillAddr = { Line1: opts.address.trim().slice(0, 500) };

  const res = await qbFetch<{ Vendor: QBVendor }>(
    `/vendor`, { method: 'POST', body: JSON.stringify(body) }, db,
  );
  return res.Vendor;
}

// Search active vendors by a name fragment (for the PO vendor picker). Runs one
// LIKE query per case variant (QBO has no OR, and LIKE is case-sensitive).
export async function searchVendors(term: string, db?: SupabaseClient): Promise<QBVendor[]> {
  const t = (term || '').trim();
  if (t.length < 2) return [];
  const cap = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  const variants = Array.from(new Set([t, t.toLowerCase(), t.toUpperCase(), cap]));
  const seen = new Set<string>();
  const out: QBVendor[] = [];
  for (const v of variants) {
    const query = `select Id, DisplayName from Vendor where Active = true and DisplayName like '%${esc(v)}%' order by DisplayName maxresults 30`;
    const res = await qbFetch<{ QueryResponse?: { Vendor?: QBVendor[] } }>(
      `/query?query=${encodeURIComponent(query)}`, undefined, db,
    );
    for (const row of res.QueryResponse?.Vendor || []) {
      if (seen.has(row.Id)) continue;
      seen.add(row.Id);
      out.push(row);
    }
  }
  return out.sort((a, b) => a.DisplayName.localeCompare(b.DisplayName));
}

// Active expense accounts (for choosing where PO bills post).
export async function listExpenseAccounts(db?: SupabaseClient): Promise<Array<{ id: string; name: string }>> {
  const query = `select Id, Name from Account where AccountType = 'Expense' and Active = true order by Name maxresults 500`;
  const res = await qbFetch<{ QueryResponse?: { Account?: { Id: string; Name: string }[] } }>(
    `/query?query=${encodeURIComponent(query)}`, undefined, db,
  );
  return (res.QueryResponse?.Account || []).map((a) => ({ id: a.Id, name: a.Name }));
}

// Fetch a Bill (for its SyncToken before a sparse update).
export async function getBill(billId: string, db?: SupabaseClient): Promise<{ Id: string; SyncToken: string; DocNumber?: string } | null> {
  const res = await qbFetch<{ Bill?: { Id: string; SyncToken: string; DocNumber?: string } }>(
    `/bill/${encodeURIComponent(billId)}`, undefined, db,
  );
  return res.Bill ?? null;
}

// Find an existing QuickBooks Bill with this DocNumber (invoice #), optionally
// for a specific vendor. Used to block pushing an invoice that's already been
// entered in QuickBooks (re-sent / previously hand-keyed bills).
export async function findBillByDocNumber(
  docNumber: string,
  vendorId?: string | null,
  db?: SupabaseClient,
): Promise<{ Id: string; DocNumber?: string } | null> {
  const query = `select Id, DocNumber, VendorRef from Bill where DocNumber = '${esc(docNumber)}'`;
  const res = await qbFetch<{ QueryResponse?: { Bill?: { Id: string; DocNumber?: string; VendorRef?: { value: string } }[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
    undefined,
    db,
  );
  const bills = res.QueryResponse?.Bill || [];
  const match = vendorId ? bills.find((b) => b.VendorRef?.value === vendorId) : bills[0];
  return match ? { Id: match.Id, DocNumber: match.DocNumber } : null;
}

// A sensible default expense account for bill lines when the parser/admin
// didn't pick one. Returns the first active Expense account.
export async function findDefaultExpenseAccount(
  db?: SupabaseClient,
): Promise<{ Id: string; Name: string } | null> {
  const query = `select Id, Name from Account where AccountType = 'Expense' and Active = true maxresults 1`;
  const res = await qbFetch<{ QueryResponse?: { Account?: { Id: string; Name: string }[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
    undefined,
    db,
  );
  return res.QueryResponse?.Account?.[0] ?? null;
}

// A bill line is item-based when it carries an itemId (posts to QuickBooks as
// an ItemBasedExpenseLine → bumps inventory QtyOnHand + COGS); otherwise it
// falls back to an account-based expense line against the default account.
export type BillLine = {
  description?: string | null;
  amount: number;
  accountId?: string | null;
  itemId?: string | null;
  qty?: number | null;
  unitCost?: number | null;
};

export async function createBill(
  opts: {
    vendorId: string;
    invoiceNumber?: string | null;
    billDate?: string | null; // 'YYYY-MM-DD' → TxnDate
    dueDate?: string | null;
    memo?: string | null;
    lines: BillLine[];
    defaultAccountId: string;
  },
  db?: SupabaseClient,
): Promise<{ Id: string; DocNumber?: string }> {
  const Line = opts.lines
    .filter((l) => Number.isFinite(l.amount) && l.amount !== 0)
    .map((l) =>
      l.itemId
        ? {
            DetailType: 'ItemBasedExpenseLine',
            Amount: Number(l.amount),
            ...(l.description ? { Description: l.description } : {}),
            ItemBasedExpenseLineDetail: {
              ItemRef: { value: l.itemId },
              ...(l.qty != null ? { Qty: Number(l.qty) } : {}),
              ...(l.unitCost != null ? { UnitPrice: Number(l.unitCost) } : {}),
            },
          }
        : {
            DetailType: 'AccountBasedExpenseLine',
            Amount: Number(l.amount),
            ...(l.description ? { Description: l.description } : {}),
            AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId || opts.defaultAccountId } },
          },
    );

  const body: Record<string, unknown> = {
    VendorRef: { value: opts.vendorId },
    Line,
  };
  if (opts.billDate) body.TxnDate = opts.billDate;
  if (opts.dueDate) body.DueDate = opts.dueDate;
  // QuickBooks caps DocNumber at 21 chars.
  if (opts.invoiceNumber) body.DocNumber = opts.invoiceNumber.slice(0, 21);
  if (opts.memo) body.PrivateNote = opts.memo;

  const res = await qbFetch<{ Bill: { Id: string; DocNumber?: string } }>(
    `/bill`,
    { method: 'POST', body: JSON.stringify(body) },
    db,
  );
  return res.Bill;
}

// Update an existing Bill (used by "edit & push"). Fetches the current bill for
// its SyncToken, then replaces the vendor/date/memo/lines. sparse update.
export async function updateBill(
  billId: string,
  opts: {
    vendorId: string;
    invoiceNumber?: string | null;
    billDate?: string | null;
    memo?: string | null;
    lines: BillLine[];
    defaultAccountId: string;
  },
  db?: SupabaseClient,
): Promise<{ Id: string; DocNumber?: string }> {
  const current = await getBill(billId, db);
  if (!current) throw new Error('That QuickBooks bill no longer exists.');

  const Line = opts.lines
    .filter((l) => Number.isFinite(l.amount) && l.amount !== 0)
    .map((l) => ({
      DetailType: 'AccountBasedExpenseLine',
      Amount: Number(l.amount),
      ...(l.description ? { Description: l.description } : {}),
      AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId || opts.defaultAccountId } },
    }));

  const body: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
    VendorRef: { value: opts.vendorId },
    Line,
  };
  if (opts.billDate) body.TxnDate = opts.billDate;
  if (opts.invoiceNumber) body.DocNumber = opts.invoiceNumber.slice(0, 21);
  if (opts.memo) body.PrivateNote = opts.memo;

  const res = await qbFetch<{ Bill: { Id: string; DocNumber?: string } }>(
    `/bill`, { method: 'POST', body: JSON.stringify(body) }, db,
  );
  return res.Bill;
}

// Outstanding balance for a set of QB Bill ids. A Bill's Balance is 0 once it's
// fully paid in QuickBooks — that's how we mirror "paid" into the app instead
// of a manual button. Batched (Intuit caps query length), returns id → balance.
export async function getBillBalances(
  billIds: string[],
  db?: SupabaseClient,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < billIds.length; i += 30) {
    const chunk = billIds.slice(i, i + 30);
    const inList = chunk.map((id) => `'${esc(id)}'`).join(',');
    const query = `select Id, Balance from Bill where Id in (${inList})`;
    const res = await qbFetch<{ QueryResponse?: { Bill?: { Id: string; Balance?: number }[] } }>(
      `/query?query=${encodeURIComponent(query)}`,
      undefined,
      db,
    );
    for (const b of res.QueryResponse?.Bill || []) {
      out.set(b.Id, Number(b.Balance ?? 0));
    }
  }
  return out;
}

// Pull payment status from QuickBooks for every pushed-but-unpaid bill and mark
// the ones with a zero balance as paid. Reused by the hourly poll cron and the
// admin "Check email now" trigger.
export async function syncBillPaidStatus(
  db: SupabaseClient,
): Promise<{ checked: number; markedPaid: number }> {
  const { data: rows } = await db
    .from('vendor_bills')
    .select('id, qb_bill_id')
    .eq('paid', false)
    .not('qb_bill_id', 'is', null);
  const bills = (rows || []) as { id: string; qb_bill_id: string }[];
  if (bills.length === 0) return { checked: 0, markedPaid: 0 };

  const balances = await getBillBalances(bills.map((b) => b.qb_bill_id), db);
  let markedPaid = 0;
  for (const b of bills) {
    const bal = balances.get(b.qb_bill_id);
    if (bal != null && bal <= 0) {
      const { error } = await db
        .from('vendor_bills')
        .update({ paid: true, paid_at: new Date().toISOString() })
        .eq('id', b.id);
      if (!error) markedPaid++;
    }
  }
  return { checked: bills.length, markedPaid };
}

type QBBill = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  VendorRef?: { value: string; name?: string };
};

// Mirror QuickBooks accounts-payable into vendor_bills so the Bills tab shows
// the real unpaid list — not just bills that happened to come through the app.
// Imports every open (Balance > 0) QB Bill, refreshes amounts/dates on ones we
// already have, and marks anything previously open but now settled as paid.
export async function syncOpenBillsFromQuickBooks(
  db: SupabaseClient,
): Promise<{ open: number; imported: number; updated: number; closed: number; failed: number; deduped: number; error?: string }> {
  // 1) Fetch all open bills from QB (paginated), deduped by Id in case a page
  // boundary returns the same bill twice.
  const openMap = new Map<string, QBBill>();
  let start = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = `select * from Bill where Balance > '0' startposition ${start} maxresults 100`;
    const res = await qbFetch<{ QueryResponse?: { Bill?: QBBill[] } }>(
      `/query?query=${encodeURIComponent(query)}`,
      undefined,
      db,
    );
    const batch = res.QueryResponse?.Bill || [];
    for (const b of batch) openMap.set(b.Id, b);
    if (batch.length < 100) break;
    start += 100;
  }
  const open = Array.from(openMap.values());

  // 2) Reconcile against what we already track. First self-heal any existing
  // duplicates (more than one row for the same QB bill) by deleting the extras.
  const { data: existingRaw } = await db
    .from('vendor_bills')
    .select('id, qb_bill_id, paid')
    .not('qb_bill_id', 'is', null);
  const byQbId = new Map<string, { id: string; qb_bill_id: string; paid: boolean }>();
  const dupeIds: string[] = [];
  for (const r of (existingRaw || []) as { id: string; qb_bill_id: string; paid: boolean }[]) {
    if (byQbId.has(r.qb_bill_id)) dupeIds.push(r.id); // a duplicate — drop it
    else byQbId.set(r.qb_bill_id, r);
  }
  let deduped = 0;
  if (dupeIds.length) {
    const { error } = await db.from('vendor_bills').delete().in('id', dupeIds);
    if (!error) deduped = dupeIds.length;
  }
  const existing = Array.from(byQbId.values());
  const openIds = new Set(open.map((b) => b.Id));

  let imported = 0;
  let updated = 0;
  let closed = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const b of open) {
    // total_amount carries the outstanding balance so "Total unpaid" is the
    // real amount owed (matches QB for partially-paid bills).
    const fields = {
      vendor_name: b.VendorRef?.name ?? null,
      vendor_qb_id: b.VendorRef?.value ?? null,
      invoice_number: b.DocNumber ?? null,
      bill_date: b.TxnDate ?? null,
      due_date: b.DueDate ?? null,
      total_amount: b.Balance ?? b.TotalAmt ?? null,
      qb_doc_number: b.DocNumber ?? null,
      paid: false,
    };
    const ex = byQbId.get(b.Id);
    if (ex) {
      const { error } = await db.from('vendor_bills').update(fields).eq('id', ex.id);
      if (error) { failed++; firstError ||= error.message; } else updated++;
    } else {
      // Note: we deliberately don't set `source` here — it defaults to 'manual'
      // (an allowed value) so the import never depends on a DB constraint
      // change. QB-imported bills are identified by qb_bill_id + status.
      const { data: inserted, error } = await db.from('vendor_bills').insert({
        ...fields,
        qb_bill_id: b.Id,
        status: 'pushed',
      }).select('id').single();
      if (error) { failed++; firstError ||= error.message; }
      else {
        imported++;
        // Track it so a repeat of this Id within the run updates, not re-inserts.
        if (inserted) byQbId.set(b.Id, { id: inserted.id, qb_bill_id: b.Id, paid: false });
      }
    }
  }

  // 3) Anything we had as open but QB no longer lists → it's been paid.
  for (const ex of existing) {
    if (!ex.paid && !openIds.has(ex.qb_bill_id)) {
      await db.from('vendor_bills').update({ paid: true, paid_at: new Date().toISOString() }).eq('id', ex.id);
      closed++;
    }
  }

  return { open: open.length, imported, updated, closed, failed, deduped, error: firstError };
}
