// POST /api/quickbooks/sync-customers
//
// Pulls every active customer from QuickBooks Online and inserts/updates
// matching rows in public.profiles. Customers that don't yet have an auth
// account exist as "imported" profiles (no auth.users row) — they can be
// selected when placing orders on their behalf.
//
// Returns a count of {created, updated, skipped} so the admin UI can show
// progress.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { getQbApiContext } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60; // syncing a large customer list can exceed 10s

type QBCustomer = {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: {
    Line1?: string;
    Line2?: string;
    City?: string;
    CountrySubDivisionCode?: string;  // state
    PostalCode?: string;
  };
  Active?: boolean;
  // Set on a QuickBooks sub-customer (a "job"/location); value = parent's Id.
  Job?: boolean;
  ParentRef?: { value?: string };
};

function formatAddress(a: QBCustomer['BillAddr']): string | null {
  if (!a) return null;
  const parts = [
    a.Line1,
    a.Line2,
    [a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(', '),
  ].filter(Boolean);
  return parts.join('\n') || null;
}

export async function POST(req: Request) {
  const supabase = createClient();

  // Optional: include inactive QB customers too (?includeInactive=true).
  const includeInactive = new URL(req.url).searchParams.get('includeInactive') === 'true';

  // 1) Admin only
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  // 2+3) Get a valid access token + API base through the SHARED refresh lock
  // (lib/quickbooks). This route used to refresh the token itself, un-serialized
  // — running alongside a balance sync / cron rotated the refresh token twice
  // and QuickBooks revoked the whole connection (the recurring 401). Now every
  // refresh path goes through the one lock, so the connection can't be revoked.
  let accessToken: string;
  let apiBase: string;
  try {
    ({ accessToken, apiBase } = await getQbApiContext());
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'QuickBooks not connected';
    const status = /not connected/i.test(msg) ? 400 : 502;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }

  // 4) Paginate through QB customers (active only)
  let startPosition = 1;
  const pageSize = 100;
  const all: QBCustomer[] = [];
  while (true) {
    const whereClause = includeInactive ? 'where Active in (true, false)' : 'where Active = true';
    const q = `select * from Customer ${whereClause} startposition ${startPosition} maxresults ${pageSize}`;
    const url = `${apiBase}/query?query=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ ok: false, error: `QB query failed: ${t}` }, { status: 502 });
    }
    const body = await r.json();
    const batch = (body?.QueryResponse?.Customer || []) as QBCustomer[];
    all.push(...batch);
    if (batch.length < pageSize) break;       // no more pages
    startPosition += pageSize;
  }

  // 5) Decide inserts/updates from a single snapshot of existing profiles so
  //    we make a handful of DB calls instead of several per customer (which
  //    timed the function out on large customer lists). Match priority:
  //    a) profile already linked via imported_from_qb_customer_id
  //    b) profile with the same email that isn't tied to a different QB id
  //    c) new "imported" profile row (random uuid, no auth.users link)
  // QB customer ids that admins have merged away as duplicates — the permanent
  // half of the merge (see /api/admin/merge-customers). This sync never
  // re-creates a profile for them, so a company entered twice in QuickBooks
  // can't keep re-appearing. Stored in app_settings (no migration needed).
  const suppressedQbIds = new Set<string>();
  {
    const { data: row } = await supabase
      .from('app_settings').select('value').eq('key', 'qb_suppressed_customers').maybeSingle();
    let arr: string[] = [];
    try { arr = row?.value ? JSON.parse(row.value) : []; } catch { arr = []; }
    if (Array.isArray(arr)) for (const id of arr) suppressedQbIds.add(String(id));
  }

  const { data: existing } = await supabase
    .from('profiles')
    .select('id, email, imported_from_qb_customer_id, business_name, role');
  const profileByQbId = new Map<string, string>();
  const profilesByEmail = new Map<string, { id: string; qbId: string | null }[]>();
  // Cautious name match: customer login/signup profiles (not already an imported
  // QB record) keyed by normalized business name. Only used when EXACTLY ONE
  // matches, so a QB customer whose email differs from the login (e.g. an
  // account set up under a personal email) links to it instead of duplicating.
  const normName = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const adoptableByName = new Map<string, { id: string }[]>();
  for (const p of (existing || []) as { id: string; email: string | null; imported_from_qb_customer_id: string | null; business_name: string | null; role: string | null }[]) {
    if (p.imported_from_qb_customer_id) profileByQbId.set(p.imported_from_qb_customer_id, p.id);
    if (!p.imported_from_qb_customer_id && p.role === 'customer' && p.business_name) {
      const k = normName(p.business_name);
      const arr = adoptableByName.get(k) || [];
      arr.push({ id: p.id });
      adoptableByName.set(k, arr);
    }
    if (p.email) {
      const key = p.email.toLowerCase();
      const arr = profilesByEmail.get(key) || [];
      arr.push({ id: p.id, qbId: p.imported_from_qb_customer_id ?? null });
      profilesByEmail.set(key, arr);
    }
  }

  type Row = Record<string, unknown>;
  type Mapping = { profile_id: string; qb_customer_id: string; qb_customer_name: string; updated_at: string };
  const inserts: Row[] = [];
  const updates: { id: string; patch: Row }[] = [];
  const mappings: Mapping[] = [];
  const claimed = new Set<string>(); // profile ids used this run (one per QB customer)
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const c of all) {
    // Never re-import a QB customer that was merged away as a duplicate.
    if (suppressedQbIds.has(String(c.Id))) { skipped++; continue; }

    const email = c.PrimaryEmailAddr?.Address?.trim() || null;
    const businessName = c.CompanyName?.trim() || c.DisplayName?.trim() || null;
    const fullName =
      c.DisplayName && c.CompanyName && c.DisplayName !== c.CompanyName ? c.DisplayName.trim() : null;
    const phone = c.PrimaryPhone?.FreeFormNumber?.trim() || null;
    const address = formatAddress(c.BillAddr);
    if (!businessName && !email) { skipped++; continue; }

    const mapping: Mapping = {
      profile_id: '',
      qb_customer_id: c.Id,
      qb_customer_name: c.DisplayName || c.CompanyName || '',
      updated_at: now,
    };

    // (a) already linked by QB id
    const linkedId = profileByQbId.get(c.Id);
    if (linkedId) {
      updates.push({ id: linkedId, patch: { business_name: businessName, full_name: fullName, email: email ?? `qb-${c.Id}@auto1oil.local`, phone, address } });
      mapping.profile_id = linkedId; mappings.push(mapping);
      claimed.add(linkedId); updated++; continue;
    }

    // (b) adopt an email-matched profile that's free and not tied to another QB id
    if (email) {
      const matches = profilesByEmail.get(email.toLowerCase()) || [];
      const adopt =
        matches.find((m) => m.qbId === c.Id && !claimed.has(m.id)) ||
        matches.find((m) => !m.qbId && !claimed.has(m.id));
      if (adopt) {
        updates.push({ id: adopt.id, patch: { business_name: businessName, full_name: fullName ?? undefined, phone: phone ?? undefined, address: address ?? undefined, imported_from_qb_customer_id: c.Id } });
        mapping.profile_id = adopt.id; mappings.push(mapping);
        claimed.add(adopt.id); updated++; continue;
      }
    }

    // (b2) cautious name match: adopt a single login profile with the same
    // business name instead of creating a duplicate. Only when EXACTLY ONE
    // free candidate matches — ambiguity falls through to a new record.
    if (businessName) {
      const cands = (adoptableByName.get(normName(businessName)) || []).filter((m) => !claimed.has(m.id));
      if (cands.length === 1) {
        const adopt = cands[0];
        updates.push({ id: adopt.id, patch: { full_name: fullName ?? undefined, phone: phone ?? undefined, address: address ?? undefined, imported_from_qb_customer_id: c.Id } });
        mapping.profile_id = adopt.id; mappings.push(mapping);
        claimed.add(adopt.id); updated++; continue;
      }
    }

    // (c) brand-new imported profile
    const newId = crypto.randomUUID();
    inserts.push({ id: newId, email: email ?? `qb-${c.Id}@auto1oil.local`, full_name: fullName, business_name: businessName, phone, address, role: 'customer', imported_from_qb_customer_id: c.Id, must_change_password: false });
    mapping.profile_id = newId; mappings.push(mapping);
    claimed.add(newId); created++;
  }

  // Execute writes in parallel chunks (per-row error isolation, but ~25x
  // fewer sequential round-trips than the old loop).
  async function runChunked<T>(items: T[], size: number, fn: (item: T) => PromiseLike<{ error: unknown } | unknown>): Promise<number> {
    let failures = 0;
    for (let i = 0; i < items.length; i += size) {
      const res = await Promise.all(items.slice(i, i + size).map((it) => fn(it)));
      for (const r of res) if (r && (r as { error?: unknown }).error) failures++;
    }
    return failures;
  }

  const insertFailures = await runChunked(inserts, 25, (row) => supabase.from('profiles').insert(row));
  created -= insertFailures;
  skipped += insertFailures;
  await runChunked(updates, 25, (u) => supabase.from('profiles').update(u.patch).eq('id', u.id));
  // Drop mappings whose profile insert failed isn't tracked precisely; mapping
  // upsert errors are non-fatal for the sync result.
  await runChunked(mappings, 50, (m) => supabase.from('customer_qb_mapping').upsert(m));

  // Ensure every imported customer profile is linked to a businesses row
  // (matched by qb_customer_id, then name) so new QB customers appear in the
  // admin business dropdown and invoice to the right QB customer.
  let businessesLinked = 0;
  const { data: linkData } = await supabase.rpc('link_qb_profiles_to_businesses');
  if (typeof linkData === 'number') businessesLinked = linkData;

  // Keep QB-linked business names in step with QuickBooks (the source of truth
  // for customer identity). Without this, a business that was first created
  // under a personal name — e.g. the contact who started the online account —
  // keeps that stale name forever even after the customer is renamed in QB.
  // Skips name_locked businesses: those were renamed by hand in the app (e.g.
  // "PartsCo" with Ted as the contact) and must not revert to the QB name.
  const bizNameUpdates = all
    .map((c) => ({ qbId: c.Id, name: (c.CompanyName?.trim() || c.DisplayName?.trim() || '') }))
    .filter((u) => u.name);
  await runChunked(bizNameUpdates, 25, (u) =>
    supabase.from('businesses').update({ name: u.name }).eq('qb_customer_id', u.qbId).eq('name_locked', false));

  // Location grouping: link each QB sub-customer's business under its parent's
  // business so the Customers tab can collapse a company's locations together.
  let locationsGrouped = 0;
  const parentByChildQb = new Map<string, string>();
  for (const c of all) { const p = c.ParentRef?.value; if (p) parentByChildQb.set(c.Id, String(p)); }
  if (parentByChildQb.size) {
    const { data: bizRows } = await supabase
      .from('businesses').select('id, qb_customer_id').not('qb_customer_id', 'is', null);
    const bizByQb = new Map<string, string>();
    for (const b of (bizRows as { id: string; qb_customer_id: string }[]) || []) bizByQb.set(String(b.qb_customer_id), b.id);
    const updates = Array.from(parentByChildQb.entries())
      .map(([childQb, parentQb]) => ({ childBiz: bizByQb.get(childQb), parentBiz: bizByQb.get(parentQb), parentQb }))
      .filter((u) => u.childBiz && u.parentBiz && u.childBiz !== u.parentBiz);
    const fails = await runChunked(updates, 25, (u) =>
      supabase.from('businesses')
        .update({ parent_business_id: u.parentBiz, qb_parent_customer_id: u.parentQb })
        .eq('id', u.childBiz as string));
    locationsGrouped = updates.length - fails;
  }

  // Heal stale business → QB links: if a business points at a QB customer that
  // no longer exists (merged/deleted in QuickBooks), re-point it at the ACTIVE
  // customer with the same name — so orders picked from the list keep invoicing
  // without a manual re-link. Uses the customers already fetched (no extra API).
  let linksHealed = 0;
  {
    const activeIds = new Set(all.map((c) => String(c.Id)));
    const activeByName = new Map<string, string>(); // normalized name → qb id
    for (const c of all) {
      if (suppressedQbIds.has(String(c.Id))) continue; // never heal back to a merged-away duplicate
      const nm = (c.CompanyName?.trim() || c.DisplayName?.trim() || '').toLowerCase();
      if (nm && !activeByName.has(nm)) activeByName.set(nm, c.Id);
    }
    const { data: bizAll } = await supabase
      .from('businesses').select('id, name, qb_customer_id').not('qb_customer_id', 'is', null);
    const healUpdates = ((bizAll as { id: string; name: string | null; qb_customer_id: string }[]) || [])
      .filter((b) => !activeIds.has(String(b.qb_customer_id)))
      .map((b) => ({ id: b.id, live: activeByName.get((b.name || '').trim().toLowerCase()) }))
      .filter((u): u is { id: string; live: string } => !!u.live);
    const healFails = await runChunked(healUpdates, 25, (u) =>
      supabase.from('businesses').update({ qb_customer_id: u.live }).eq('id', u.id));
    linksHealed = healUpdates.length - healFails;
  }

  return NextResponse.json({
    ok: true,
    linksHealed,
    qb_customers_seen: all.length,
    created,
    updated,
    skipped,
    businessesLinked,
    locationsGrouped,
  });
}
