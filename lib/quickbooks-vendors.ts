// QuickBooks Vendors + expense accounts — mirrors the patterns in
// lib/quickbooks.ts (reuses qbFetch for auth/refresh). Backs the vendor and
// expense-account pickers exposed at /api/quickbooks/{vendors,expense-accounts}.

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
