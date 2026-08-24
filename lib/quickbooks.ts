// ============================================================================
// QuickBooks Online client — server-only
// ============================================================================
// Handles OAuth token storage/refresh + thin wrappers around the QBO REST API
// endpoints we use. Tokens live in public.quickbooks_connection, gated by
// admin-only RLS so customers / drivers / salesmen can never read them.
//
// Required Vercel env vars:
//   - QUICKBOOKS_CLIENT_ID
//   - QUICKBOOKS_CLIENT_SECRET
//   - QUICKBOOKS_REDIRECT_URI  (e.g. https://stallion.vercel.app/api/quickbooks/callback)
//
// Never import this from a client component — refresh tokens must not be
// shipped to the browser.

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

// ── Endpoints ────────────────────────────────────────────────────────────────
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL     = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function apiBase(env: 'sandbox' | 'production', realmId: string) {
  const host = env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
  return `${host}/v3/company/${realmId}`;
}

// ── Public types ─────────────────────────────────────────────────────────────
export type QBConnection = {
  realm_id: string;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  environment: 'sandbox' | 'production';
};

export type QBCustomer = {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address: string };
  CompanyName?: string;
  Active?: boolean;
};

export type QBItem = {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Sku?: string;
  UnitPrice?: number;
  PurchaseCost?: number;
  SyncToken?: string;
  Active?: boolean;
  Type?: string;
  TrackQtyOnHand?: boolean;
  QtyOnHand?: number;
  ReorderPoint?: number;
};

export type QBInvoice = {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
};

// ── OAuth: build the authorize URL ───────────────────────────────────────────
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QUICKBOOKS_CLIENT_ID!,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI!,
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ── OAuth: exchange the code for tokens ──────────────────────────────────────
export async function exchangeCodeForTokens(code: string): Promise<{
  refresh_token: string;
  access_token: string;
  expires_in: number;       // seconds for access token
  x_refresh_token_expires_in: number;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI!,
  });
  return tokenRequest(body);
}

// ── OAuth: refresh access token using refresh token ──────────────────────────
async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return tokenRequest(body);
}

// Append an entry to the token-refresh audit log (service role — never blocks
// or breaks the token flow). Lets us see the exact refresh sequence when the
// connection is revoked: double-use of one token, a save that didn't persist,
// or an out-of-band reconnect. Fingerprints are only the last 6 chars.
//
// Stored as a JSON array in app_settings (key 'qb_token_log') — a table that
// ALREADY exists, so no migration/SQL is required to turn diagnostics on.
export const QB_TOKEN_LOG_KEY = 'qb_token_log';

// Record the fingerprint of the refresh token THIS app just wrote, so the
// foreign-write detector in getValidAccessToken can tell an outside rewrite from
// our own. Call after every successful token save (refresh) or reconnect.
export async function recordOwnedSuffix(refreshToken: string | null | undefined) {
  try {
    await createAdminClient()
      .from('app_settings')
      .upsert({ key: 'qb_owned_suffix', value: (refreshToken || '').slice(-6) }, { onConflict: 'key' });
  } catch { /* best effort */ }
}

export async function logTokenEvent(
  event: string,
  fields: { old_suffix?: string; new_suffix?: string; detail?: string } = {},
) {
  try {
    const db = createAdminClient();
    const { data } = await db.from('app_settings').select('value').eq('key', QB_TOKEN_LOG_KEY).maybeSingle();
    let arr: unknown[] = [];
    try { arr = data?.value ? JSON.parse(data.value) : []; } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({
      at: new Date().toISOString(),
      event,
      old_suffix: fields.old_suffix ?? null,
      new_suffix: fields.new_suffix ?? null,
      detail: fields.detail ?? null,
    });
    arr = arr.slice(0, 25); // keep the most recent 25 events
    await db.from('app_settings').upsert({ key: QB_TOKEN_LOG_KEY, value: JSON.stringify(arr) }, { onConflict: 'key' });
  } catch { /* logging must never break the token flow */ }
}

async function tokenRequest(body: URLSearchParams) {
  const basic = Buffer.from(
    `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`,
  ).toString('base64');

  // Hard timeout so a stalled token call can never outlive the refresh lock
  // (which would let a second caller reuse the same refresh token and get the
  // whole connection revoked). Must stay well under REFRESH_LOCK_MS.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QuickBooks token request failed: ${res.status} ${text}`);
  }
  return res.json();
}

// ── Get a valid access token, refreshing if needed ───────────────────────────
// The connection is a single global app credential (quickbooks_connection id=1)
// behind admin-only RLS, so we ALWAYS read it with the service-role client.
// Otherwise a QB call made under a non-admin session — e.g. a salesman/driver
// placing an order that auto-posts — can't see the row and wrongly reports
// "QuickBooks is not connected". `db` may still be passed but defaults to
// service-role either way.
async function getValidAccessToken(_db?: SupabaseClient): Promise<{
  accessToken: string;
  realmId: string;
  environment: 'sandbox' | 'production';
}> {
  // ALWAYS use the service-role client for the token store + refresh lock —
  // never the caller's cookie client. quickbooks_connection is admin-only RLS,
  // and a cookie-scoped UPDATE silently matches 0 rows (PostgREST returns no
  // error). That meant a page-load refresh would rotate the QB refresh token
  // but fail to persist the rotated value, so the NEXT session refreshed with a
  // token QuickBooks had already invalidated → "AuthenticationFailed / 401" and
  // a forced reconnect on every login. Service role bypasses RLS, so the
  // rotated token is always saved. (_db is ignored, kept for signature compat.)
  const supabase = createAdminClient();
  const { data: conn, error } = await supabase
    .from('quickbooks_connection')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Could not load QB connection: ${error.message}`);
  if (!conn) throw new Error('QuickBooks is not connected. Visit /admin/quickbooks to connect.');

  const c = conn as QBConnection & { id: number };

  // Foreign-write detector: every time THIS app saves a token it records the
  // fingerprint in app_settings 'qb_owned_suffix'. If the stored token no longer
  // matches, something OTHER than this app's code rewrote it — the definitive
  // test for a second writer sharing the database. Logged, not inferred.
  try {
    const { data: ownRow } = await supabase.from('app_settings').select('value').eq('key', 'qb_owned_suffix').maybeSingle();
    const owned = ownRow?.value || null;
    const cur = (c.refresh_token || '').slice(-6);
    if (owned && cur && owned !== cur) {
      await logTokenEvent('foreign_change', { old_suffix: owned, new_suffix: cur, detail: `dep=${process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_REF || 'local'}` });
      await supabase.from('app_settings').upsert({ key: 'qb_owned_suffix', value: cur }, { onConflict: 'key' });
    }
  } catch { /* detector must never break the token flow */ }

  const expired =
    !c.access_token ||
    !c.access_token_expires_at ||
    new Date(c.access_token_expires_at).getTime() < Date.now() + 60_000; // 1 min buffer

  if (!expired && c.access_token) {
    return { accessToken: c.access_token, realmId: c.realm_id, environment: c.environment };
  }

  const fresh = (co: (QBConnection & { id: number }) | null) =>
    !!co?.access_token && !!co.access_token_expires_at &&
    new Date(co.access_token_expires_at).getTime() > Date.now() + 60_000;

  // The token needs refreshing. QuickBooks REVOKES the whole token family if a
  // refresh token is used twice, so two serverless calls refreshing at once (a
  // cron + a user action) can kill the connection. Serialize with a short
  // distributed lock in `app_settings` (a table that always exists — NO
  // migration needed). An atomic conditional UPDATE (row-locked in Postgres)
  // means only ONE caller claims the refresh; everyone else waits for the token.
  const LOCK_KEY = 'qb_refresh_lock';
  const PAST = '1970-01-01T00:00:00.000Z';           // "unlocked" marker
  // The lock must outlive a full refresh (≤20s token call + a save) so it can
  // NEVER expire mid-refresh and let a second caller reuse the refresh token.
  const REFRESH_LOCK_MS = 60_000;

  // Compare-and-swap: only write our refreshed token if the stored refresh
  // token is STILL the one we refreshed. If a reconnect (or anything else)
  // changed it while our Intuit call was in flight, the WHERE matches 0 rows and
  // we DON'T clobber the newer token with our now-stale one. Returns true iff
  // our write landed. (This was the bug: a reconnect's fresh token kept getting
  // overwritten by an in-flight refresh of the old token, so reconnects never
  // stuck and the connection died on the stale token.)
  const saveToken = async (r: { access_token: string; expires_in: number; refresh_token?: string }, expectedRefresh: string): Promise<boolean> => {
    const { data } = await supabase.from('quickbooks_connection').update({
      access_token: r.access_token,
      access_token_expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString(),
      refresh_token: r.refresh_token ?? expectedRefresh,
      updated_at: new Date().toISOString(),
    }).eq('id', 1).eq('refresh_token', expectedRefresh).select('id');
    return (data?.length ?? 0) > 0;
  };
  const releaseLock = async () => {
    try { await supabase.from('app_settings').update({ value: PAST }).eq('key', LOCK_KEY); } catch { /* best effort */ }
  };
  const readConn = async () => {
    const { data } = await supabase.from('quickbooks_connection').select('*').eq('id', 1).maybeSingle();
    return data as (QBConnection & { id: number }) | null;
  };
  // Atomically claim the lock: succeeds only if it's currently free/expired.
  // A fresh `now` each call means a crashed holder's lock (value in the past
  // after its window) can be re-claimed. Postgres re-evaluates the WHERE
  // after row-locking a concurrently-updated row, so exactly one caller wins.
  const tryClaim = async (): Promise<boolean> => {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + REFRESH_LOCK_MS).toISOString();
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .update({ value: until })
        .eq('key', LOCK_KEY)
        .lt('value', now)
        .select('key')
        .maybeSingle();
      return !error && !!data;
    } catch { return false; }
  };

  try {
    await supabase.from('app_settings').upsert({ key: LOCK_KEY, value: PAST }, { onConflict: 'key', ignoreDuplicates: true });
  } catch { /* row may already exist — fine */ }

  let gotLock = await tryClaim();

  // If we didn't get the lock, another instance is refreshing. Wait for the
  // token it writes, re-trying the claim each round (in case that holder died
  // and its lock has since expired). CRITICAL: we NEVER refresh without holding
  // the lock — an unsynchronized refresh reuses the rotating refresh token and
  // QuickBooks then revokes the whole connection (the recurring reconnect bug).
  if (!gotLock) {
    // Poll longer than a full refresh can take (≤~21s) so we actually receive
    // the holder's fresh token instead of falling through: 56 × 500ms = 28s.
    for (let i = 0; i < 56; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const f = await readConn();
      if (fresh(f)) return { accessToken: f!.access_token!, realmId: f!.realm_id, environment: f!.environment };
      gotLock = await tryClaim();
      if (gotLock) break;
    }
  }

  if (!gotLock) {
    // Couldn't get the lock and no fresh token appeared. Use the current access
    // token if it's at all still valid; otherwise ask the caller to retry —
    // never do an un-serialized refresh.
    const f = await readConn();
    if (f?.access_token && f.access_token_expires_at && new Date(f.access_token_expires_at).getTime() > Date.now()) {
      return { accessToken: f.access_token, realmId: f.realm_id, environment: f.environment };
    }
    throw new Error('QuickBooks is busy refreshing its access token — please try again in a few seconds.');
  }

  // We hold the lock. Re-read: a holder just before us may have refreshed.
  const lc = (await readConn()) ?? c;
  if (fresh(lc)) {
    await releaseLock();
    return { accessToken: lc.access_token!, realmId: lc.realm_id, environment: lc.environment };
  }

  const oldSuffix = (lc.refresh_token || '').slice(-6);
  await logTokenEvent('refresh_attempt', { old_suffix: oldSuffix });
  try {
    const refreshed = await refreshAccessToken(lc.refresh_token);
    const saved = await saveToken(refreshed, lc.refresh_token); // compare-and-swap
    if (!saved) {
      // The stored token changed while we were refreshing — almost always a
      // reconnect that just wrote a fresh token. Do NOT overwrite it. Use
      // whatever is current now instead of our stale result.
      const cur = await readConn();
      await logTokenEvent('refresh_superseded', {
        old_suffix: oldSuffix,
        new_suffix: (cur?.refresh_token || '').slice(-6),
        detail: 'stored token changed mid-refresh — kept the newer one',
      });
      await releaseLock();
      if (cur && fresh(cur)) return { accessToken: cur.access_token!, realmId: cur.realm_id, environment: cur.environment };
      return { accessToken: refreshed.access_token, realmId: lc.realm_id, environment: lc.environment };
    }
    // Verify the rotated token actually persisted (read-after-write).
    const after = await readConn();
    await recordOwnedSuffix(after?.refresh_token);  // mark this write as ours
    await logTokenEvent('refresh_ok', {
      old_suffix: oldSuffix,
      new_suffix: (refreshed.refresh_token || '').slice(-6),
      detail: `saved_suffix=${(after?.refresh_token || '').slice(-6)}`,
    });
    await releaseLock();
    return { accessToken: refreshed.access_token, realmId: lc.realm_id, environment: lc.environment };
  } catch (e) {
    await logTokenEvent('refresh_fail', { old_suffix: oldSuffix, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    await releaseLock();
    throw e;
  }
}

// Force the stored access token to look expired so the NEXT getValidAccessToken
// performs a real (serialized) refresh. Used to self-heal a 401 from a token
// that QuickBooks rejected even though we thought it was still valid.
async function invalidateStoredAccessToken() {
  try {
    await createAdminClient()
      .from('quickbooks_connection')
      .update({ access_token_expires_at: '1970-01-01T00:00:00.000Z' })
      .eq('id', 1);
  } catch { /* best effort */ }
}

// ── Generic API caller ───────────────────────────────────────────────────────
// `db` is forwarded to the token loader — pass a service-role client from
// cron/webhook contexts (see getValidAccessToken).
export async function qbFetch<T>(path: string, init?: RequestInit, db?: SupabaseClient): Promise<T> {
  const call = async () => {
    const { accessToken, realmId, environment } = await getValidAccessToken(db);
    const url = `${apiBase(environment, realmId)}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  };

  let res = await call();
  // A 401 means the access token we sent was rejected. It may simply be stale
  // (e.g. refreshed elsewhere, or an edge in expiry timing) while the refresh
  // token is still good — so force ONE serialized refresh and retry before
  // surfacing an auth error. If the refresh token is genuinely dead, the retry
  // throws too and the caller sees the reconnect message.
  if (res.status === 401) {
    await invalidateStoredAccessToken();
    res = await call();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QuickBooks ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Public: a valid access token + the resolved company API base, obtained
// through the SAME serialized refresh lock as qbFetch. Routes that build raw
// paginated fetch URLs (e.g. the customer batch sync) MUST use this instead of
// calling the QB token endpoint themselves — two un-serialized refreshes rotate
// the refresh token concurrently and QuickBooks then revokes the whole token
// family (the recurring "AuthenticationFailed / 401" disconnect).
export async function getQbApiContext(db?: SupabaseClient): Promise<{ accessToken: string; apiBase: string }> {
  const { accessToken, realmId, environment } = await getValidAccessToken(db);
  return { accessToken, apiBase: apiBase(environment, realmId) };
}

// ── Customer endpoints ───────────────────────────────────────────────────────
export async function findCustomerByName(name: string): Promise<QBCustomer | null> {
  const escaped = name.replace(/'/g, "''");
  const query = `select * from Customer where DisplayName = '${escaped}'`;
  const res = await qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
  );
  return res.QueryResponse.Customer?.[0] ?? null;
}

// Search ACTIVE customers by a name fragment for the admin re-link picker.
// QuickBooks' LIKE is case-sensitive, so query a few case variants and dedupe.
export async function searchCustomers(term: string): Promise<QBCustomer[]> {
  const t = (term || '').trim();
  if (t.length < 2) return [];
  const esc = (s: string) => s.replace(/'/g, "''");
  const cap = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  // QuickBooks' query language has no OR operator and its LIKE is case-sensitive,
  // so run one single-LIKE query per case variant and merge the results.
  const variants = Array.from(new Set([t, t.toLowerCase(), t.toUpperCase(), cap]));
  try {
    const batches = await Promise.all(variants.map((v) =>
      qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
        `/query?query=${encodeURIComponent(`select * from Customer where DisplayName like '%${esc(v)}%' maxresults 25`)}`,
      ),
    ));
    const seen = new Set<string>();
    const out: QBCustomer[] = [];
    for (const res of batches) {
      for (const c of res.QueryResponse.Customer || []) {
        if (c.Active === false || seen.has(c.Id)) continue;
        seen.add(c.Id);
        out.push(c);
      }
    }
    return out;
  } catch (e) {
    if (isQbAuthError(e)) throw e;
    return [];
  }
}

// Find an active customer by email — used before auto-creating one, so a
// customer already in QuickBooks under a slightly different name (e.g. "PartsCo"
// vs "PartsCo. L.C.") is matched and linked instead of duplicated.
export async function findCustomerByEmail(email: string): Promise<QBCustomer | null> {
  const escaped = email.replace(/'/g, "''");
  try {
    const res = await qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
      `/query?query=${encodeURIComponent(`select * from Customer where PrimaryEmailAddr = '${escaped}'`)}`,
    );
    return (res.QueryResponse.Customer || []).find((c) => c.Active !== false) ?? null;
  } catch {
    return null;
  }
}

// Fetch a customer by id; returns null if it's missing or inactive/deleted
// (e.g. it was merged away in QuickBooks, which deletes the merged record).
// A QuickBooks connection/auth failure (expired token, revoked grant, 401) — as
// opposed to a genuine "customer not found". These must NOT be swallowed as
// "customer deleted", or the app tells the user to re-link a customer that is
// perfectly fine when the real problem is the QuickBooks connection.
export function isQbAuthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? '');
  return /\b401\b|authenticationfailed|invalid_grant|not connected|token/i.test(m);
}

export async function getActiveCustomer(id: string): Promise<QBCustomer | null> {
  try {
    const res = await qbFetch<{ Customer: QBCustomer }>(`/customer/${encodeURIComponent(id)}`);
    const c = res.Customer;
    return c && c.Active !== false ? c : null;
  } catch (e) {
    if (isQbAuthError(e)) throw e;   // connection problem — don't fake "deleted"
    return null;                     // genuine not-found / merged customer
  }
}

// Re-find an ACTIVE customer after a stored id turned out to be deleted (merged
// in QuickBooks). Matches by NAME only — many customers have no email on file,
// so email is unreliable and can mis-match. Tries exact DisplayName, then a
// case-insensitive name search ("PartsCo" finds "PartsCo. L.C.").
export async function reFindActiveCustomer(opts: { name?: string | null }): Promise<QBCustomer | null> {
  const esc = (s: string) => s.replace(/'/g, "''");
  const run = async (where: string): Promise<QBCustomer | null> => {
    try {
      const res = await qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
        `/query?query=${encodeURIComponent(`select * from Customer where ${where}`)}`,
      );
      return (res.QueryResponse.Customer || []).find((c) => c.Active !== false) ?? null;
    } catch (e) { if (isQbAuthError(e)) throw e; return null; }
  };
  const name = opts.name?.trim();
  if (name) {
    const exact = await run(`DisplayName = '${esc(name)}'`);
    if (exact) return exact;
    const token = name.split(/[\s,]+/)[0];
    if (token && token.length >= 2) {
      // Case-insensitive fallback (QB's `=`/LIKE are case-sensitive): search the
      // token in several case variants and match the full name in JS.
      const cands = await searchCustomers(token);
      const want = name.toLowerCase();
      return cands.find((c) => (c.DisplayName || '').toLowerCase() === want)
        ?? cands.find((c) => (c.DisplayName || '').toLowerCase().includes(token.toLowerCase()))
        ?? null;
    }
  }
  return null;
}

export async function createCustomer(opts: {
  displayName: string;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  billAddress?: string | null;
}): Promise<QBCustomer> {
  const body: Record<string, any> = { DisplayName: opts.displayName };
  if (opts.companyName) body.CompanyName = opts.companyName;
  if (opts.email) body.PrimaryEmailAddr = { Address: opts.email };
  if (opts.phone) body.PrimaryPhone = { FreeFormNumber: opts.phone };
  if (opts.billAddress) body.BillAddr = { Line1: opts.billAddress };

  const res = await qbFetch<{ Customer: QBCustomer }>('/customer', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.Customer;
}

// ── Item (product) endpoints ─────────────────────────────────────────────────
// Find an item by name. QuickBooks stores an item's `Name` as just the leaf
// (e.g. "SUPREME UHP DEXOS 0W-20"); the "GAL:SUPREME UHP DEXOS 0W-20" form is
// the FullyQualifiedName, which isn't reliably filterable. So query by the leaf
// name, then disambiguate by the full name. Matching by the full name directly
// finds nothing and makes callers try to (re)create an item that already exists
// — QuickBooks then rejects it with a Duplicate Name error.
export async function findItemByName(name: string): Promise<QBItem | null> {
  const full = (name || '').trim();
  if (!full) return null;
  const i = full.lastIndexOf(':');
  const leaf = i >= 0 ? full.slice(i + 1).trim() : full;
  const escaped = leaf.replace(/'/g, "''");
  const query = `select * from Item where Name = '${escaped}'`;
  const res = await qbFetch<{ QueryResponse: { Item?: QBItem[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
  );
  const candidates = res.QueryResponse.Item || [];
  if (candidates.length <= 1) return candidates[0] ?? null;
  // Same leaf under different parents — pick the one whose full path matches.
  const fullLower = full.toLowerCase();
  return candidates.find((c) => (c.FullyQualifiedName || c.Name || '').toLowerCase() === fullLower) ?? candidates[0];
}

export async function createItem(opts: {
  name: string;
  unitPrice?: number;
  incomeAccountRef: string;    // QB account "Id" — usually "Sales" or similar
}): Promise<QBItem> {
  const body: Record<string, any> = {
    Name: opts.name,
    Type: 'NonInventory',
    IncomeAccountRef: { value: opts.incomeAccountRef },
  };
  if (opts.unitPrice != null) body.UnitPrice = opts.unitPrice;

  const res = await qbFetch<{ Item: QBItem }>('/item', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.Item;
}

// Reactivate an archived (inactive) QuickBooks item so it can go on a
// transaction again. QB blocks invoicing an inactive inventory item with
// "You need to activate this item before updating the quantity" (code 6000).
// Fetches the current SyncToken and only writes if the item is actually
// inactive. Returns the item name + whether it was flipped active.
export async function reactivateItem(qbItemId: string): Promise<{ name: string; reactivated: boolean }> {
  const res = await qbFetch<{ Item: QBItem }>(`/item/${encodeURIComponent(qbItemId)}`);
  const item = res.Item;
  if (item.Active !== false) return { name: item.Name, reactivated: false };
  await qbFetch<{ Item: QBItem }>('/item', {
    method: 'POST',
    body: JSON.stringify({ Id: item.Id, SyncToken: item.SyncToken, sparse: true, Active: true }),
  });
  return { name: item.Name, reactivated: true };
}

// Find the "Sales" income account (used as default when auto-creating items)
export async function findSalesIncomeAccount(): Promise<{ Id: string; Name: string } | null> {
  const query = `select * from Account where AccountType = 'Income' maxresults 1`;
  const res = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string; Name: string }> } }>(
    `/query?query=${encodeURIComponent(query)}`,
  );
  return res.QueryResponse.Account?.[0] ?? null;
}

// ── Invoice ──────────────────────────────────────────────────────────────────
export type InvoiceLineInput = {
  qbItemId: string;
  qbItemName: string;
  quantity: number;
  unitPrice?: number;          // override default item price if set
  description?: string;
  // Sub-cent per-unit tax/fee lines: omit UnitPrice and send Amount+Qty so QB
  // derives the rate itself. Sending all three lets QB's rounding of
  // UnitPrice×Qty disagree with our Amount and reject with error 6070.
  taxLine?: boolean;
};

/**
 * Look up the highest existing numeric DocNumber in QB, return the next one.
 * QB companies with "Custom transaction numbers" enabled won't auto-assign
 * a DocNumber if we don't pass one — so we compute it ourselves.
 */
export async function getNextInvoiceDocNumber(): Promise<string | null> {
  try {
    // Pull the 100 most recent invoices and find the highest numeric DocNumber.
    // (DocNumber sort in QB API is lexicographic, so we have to do it client-side.)
    const query = 'select DocNumber from Invoice orderby Id desc maxresults 100';
    const res = await qbFetch<{ QueryResponse: { Invoice?: Array<{ DocNumber?: string }> } }>(
      `/query?query=${encodeURIComponent(query)}`,
    );
    const nums = (res.QueryResponse.Invoice || [])
      .map((i) => i.DocNumber)
      .filter((d): d is string => !!d && /^\d+$/.test(d))
      .map((d) => parseInt(d, 10));
    if (nums.length === 0) return null;
    return String(Math.max(...nums) + 1);
  } catch (e) {
    console.warn('Could not determine next DocNumber:', e);
    return null;
  }
}

// The sales-form custom field that holds the customer PO number. The label must
// match what was set up in QuickBooks (Settings → Custom fields). Override with
// QB_PO_FIELD_NAME if it's named differently.
const PO_FIELD_NAME = process.env.QB_PO_FIELD_NAME || 'PO Number';

// Resolve the DefinitionId of the PO custom field from QuickBooks Preferences,
// so we can write it on invoices. Classic sales custom fields are numbered 1-3;
// that number is the transaction CustomField DefinitionId. Cached; returns null
// if there's no matching field (caller then falls back to the memo).
let _poFieldId: string | null | undefined;
async function getPoCustomFieldId(): Promise<string | null> {
  if (_poFieldId !== undefined) return _poFieldId;
  try {
    const res = await qbFetch<{ QueryResponse?: { Preferences?: Array<{ SalesFormsPrefs?: { CustomField?: Array<{ CustomField?: Array<{ Name?: string; StringValue?: string }> }> } }> } }>(
      `/query?query=${encodeURIComponent('select * from Preferences')}`,
    );
    const entries = res.QueryResponse?.Preferences?.[0]?.SalesFormsPrefs?.CustomField?.[0]?.CustomField || [];
    const target = PO_FIELD_NAME.toLowerCase();
    for (const e of entries) {
      const m = e.Name?.match(/CustomField\.(\d+)\.Name$/);
      if (m && (e.StringValue || '').toLowerCase().includes(target)) {
        _poFieldId = m[1];
        return _poFieldId;
      }
    }
    _poFieldId = null;
  } catch (err) {
    console.warn('getPoCustomFieldId failed:', err);
    _poFieldId = null;
  }
  return _poFieldId;
}

// The sales-form custom field that holds the salesman name. Override via
// QB_SALESMAN_FIELD_NAME if it's named differently in your QuickBooks.
const SALESMAN_FIELD_NAME = process.env.QB_SALESMAN_FIELD_NAME || 'Salesman';
let _salesmanFieldId: string | null | undefined;
async function getSalesmanCustomFieldId(): Promise<string | null> {
  if (_salesmanFieldId !== undefined) return _salesmanFieldId;
  try {
    const res = await qbFetch<{ QueryResponse?: { Preferences?: Array<{ SalesFormsPrefs?: { CustomField?: Array<{ CustomField?: Array<{ Name?: string; StringValue?: string }> }> } }> } }>(
      `/query?query=${encodeURIComponent('select * from Preferences')}`,
    );
    const entries = res.QueryResponse?.Preferences?.[0]?.SalesFormsPrefs?.CustomField?.[0]?.CustomField || [];
    const targets = [SALESMAN_FIELD_NAME.toLowerCase(), 'salesman', 'sales rep'];
    for (const e of entries) {
      const m = e.Name?.match(/CustomField\.(\d+)\.Name$/);
      const val = (e.StringValue || '').toLowerCase();
      if (m && targets.some((t) => val.includes(t))) { _salesmanFieldId = m[1]; return _salesmanFieldId; }
    }
    _salesmanFieldId = null;
  } catch (err) {
    console.warn('getSalesmanCustomFieldId failed:', err);
    _salesmanFieldId = null;
  }
  return _salesmanFieldId;
}

// QuickBooks rejects a line (error 6070) unless Amount === round(UnitPrice × Qty).
// JS `(rate*qty).toFixed(2)` truncates at half-cent float boundaries — e.g.
// 0.385 × 1863 = 717.255 → toFixed gives 717.25 but QB rounds to 717.26 — so the
// line is a cent off and QB rejects it. Compute with integer math (rate snapped
// to QB's 5-decimal max, then round half-up to cents) so it matches QB exactly.
function qbLineAmount(rate: number, qty: number): number {
  return Math.round((Math.round(rate * 1e5) * qty) / 1e3) / 100;
}

export async function createInvoice(opts: {
  qbCustomerId: string;
  lines: InvoiceLineInput[];
  customerMemo?: string;
  /** Explicit DocNumber. If omitted, we ask QB for the next sequential one. */
  docNumber?: string;
  /** QB SalesTerm Id to print on the invoice (the "Terms" field). */
  salesTermId?: string;
  /** Customer PO number → printed on the invoice's PO custom field. */
  poNumber?: string;
  /** Salesman name → written to the salesman sales-form custom field. */
  salesmanName?: string;
  /** Salesman's QuickBooks Class → set on every line. */
  salesmanClass?: string;
  /** Sales tax: true = charge tax on product lines, false/undefined = no tax
   *  (every line marked NON). Tax/fee lines are never sales-taxed. */
  taxable?: boolean;
}): Promise<QBInvoice> {
  const docNumber = opts.docNumber ?? (await getNextInvoiceDocNumber());

  // Resolve the rep's Class id, used to tag each line so QuickBooks reports
  // P&L by rep.
  let baseClassId: string | null = null;
  if (opts.salesmanClass) {
    try {
      const byName = new Map<string, string>();
      for (const c of await listClasses()) {
        byName.set(c.Name.toLowerCase(), c.Id);
        if (c.FullyQualifiedName) byName.set(c.FullyQualifiedName.toLowerCase(), c.Id);
      }
      baseClassId = byName.get(opts.salesmanClass.toLowerCase()) || null;
    } catch { /* class tagging is best-effort */ }
  }

  // Every line needs Line.Amount or QB rejects with code 2020. We compute
  // it as qty × unitPrice from whichever price the caller resolved (admin
  // override, customer history, or the QB item's default). UnitPrice is
  // sent alongside so QB stores it on the line.
  //
  // Description ALWAYS gets sent as the item name so the printed invoice
  // shows what each charge is — QB doesn't auto-fill the Description column
  // from the item record on API-created invoices. If the caller passed an
  // extra description (e.g. customer order notes for that line), it gets
  // appended after the item name.
  const body: Record<string, any> = {
    CustomerRef: { value: opts.qbCustomerId },
    Line: opts.lines.map((l) => {
      const unitPrice = typeof l.unitPrice === 'number' ? l.unitPrice : 0;
      // Round a tax/fee rate to 5 decimals (QuickBooks' max for a unit
      // price) and derive the Amount from that same value, so QB's
      // "Amount = Qty × UnitPrice" check can't fail (the old error 6070) — while
      // still sending the rate so it prints in the Rate column.
      const rate = l.taxLine ? Math.round(unitPrice * 1e5) / 1e5 : unitPrice;
      const description = l.description
        ? `${l.qbItemName} — ${l.description}`
        : l.qbItemName;
      const detail: Record<string, any> = {
        ItemRef: { value: l.qbItemId, name: l.qbItemName },
        Qty: l.quantity,
      };
      // Send the unit price on every line (incl. tax lines) so the rate prints.
      detail.UnitPrice = rate;
      // Rep class per line, so QuickBooks can report P&L by rep.
      if (baseClassId) detail.ClassRef = { value: baseClassId };
      // Sales tax: charge it on a line only when the order is taxable AND the
      // line isn't a tax/fee line. Default (and exempt customers) → NON.
      if (opts.taxable !== undefined) {
        detail.TaxCodeRef = { value: opts.taxable && !l.taxLine ? 'TAX' : 'NON' };
      }
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: qbLineAmount(rate, l.quantity),
        Description: description,
        SalesItemLineDetail: detail,
      };
    }),
  };
  if (docNumber) body.DocNumber = docNumber;
  if (opts.customerMemo) body.CustomerMemo = { value: opts.customerMemo };
  // Print the payment terms on the invoice (see resolveInvoiceTermId).
  if (opts.salesTermId) body.SalesTermRef = { value: opts.salesTermId };

  // Sales-form custom fields: PO number and the salesman name. Each writes to
  // its custom field if QuickBooks has one; the PO falls back to the memo.
  const customFields: Array<Record<string, unknown>> = [];
  if (opts.poNumber) {
    const poFieldId = await getPoCustomFieldId();
    if (poFieldId) {
      customFields.push({ DefinitionId: poFieldId, Name: PO_FIELD_NAME, Type: 'StringType', StringValue: opts.poNumber });
    } else {
      const existing = body.CustomerMemo?.value;
      body.CustomerMemo = { value: existing ? `PO #: ${opts.poNumber}\n${existing}` : `PO #: ${opts.poNumber}` };
    }
  }
  if (opts.salesmanName) {
    const sId = await getSalesmanCustomFieldId();
    if (sId) customFields.push({ DefinitionId: sId, Name: SALESMAN_FIELD_NAME, Type: 'StringType', StringValue: opts.salesmanName });
  }
  if (customFields.length) body.CustomField = customFields;

  // Create the invoice. Two orders auto-posting back-to-back can both grab the
  // same next DocNumber (max+1); QB accepts the first and rejects the second as
  // a duplicate. On that specific error, re-fetch the next number (which now
  // moves past the just-created invoice) and retry, so neither order is lost.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await qbFetch<{ Invoice: QBInvoice }>('/invoice', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return res.Invoice;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate document number|"?code"?\s*[:=]\s*"?6140/i.test(msg)) throw e;
      const next = await getNextInvoiceDocNumber();
      if (next) body.DocNumber = next;
      else delete body.DocNumber; // can't compute → let QB assign its own
    }
  }
  throw lastErr;
}

// ── Payment terms on invoices ────────────────────────────────────────────────
// Net 10 = a QB SalesTerm with DueDays = 10. We find it by DueDays (not by
// name) so it works regardless of how the term is labeled ("Net 10", "NET10",
// etc.). Cached for the life of the server process.
let _net10TermIdCache: string | null | undefined;
export async function getNet10TermId(): Promise<string | null> {
  if (_net10TermIdCache !== undefined) return _net10TermIdCache;
  try {
    const res = await qbFetch<{ QueryResponse: { Term?: Array<{ Id: string; Name?: string; DueDays?: number }> } }>(
      `/query?query=${encodeURIComponent('select Id, Name, DueDays from Term maxresults 500')}`,
    );
    const terms = res.QueryResponse.Term || [];
    const net10 =
      terms.find((t) => Number(t.DueDays) === 10) ??
      terms.find((t) => /net\s*10\b/i.test(t.Name || ''));
    _net10TermIdCache = net10?.Id ?? null;
  } catch (e) {
    console.warn('getNet10TermId failed:', e);
    _net10TermIdCache = null;
  }
  return _net10TermIdCache;
}

// Void an invoice in QuickBooks by its DocNumber (the invoice # we store on
// orders). Voiding keeps the invoice + number but zeroes it to $0, so it no
// longer affects A/R — the audit-friendly alternative to deleting. Returns
// whether it found and voided the invoice.
export async function voidInvoiceByDocNumber(
  docNumber: string,
  db?: SupabaseClient,
): Promise<{ voided: boolean; reason?: string }> {
  const escaped = docNumber.replace(/'/g, "\\'");
  const res = await qbFetch<{ QueryResponse?: { Invoice?: { Id: string; SyncToken: string }[] } }>(
    `/query?query=${encodeURIComponent(`select Id, SyncToken from Invoice where DocNumber = '${escaped}'`)}`,
    undefined,
    db,
  );
  const inv = res.QueryResponse?.Invoice?.[0];
  if (!inv) return { voided: false, reason: 'invoice not found in QuickBooks' };
  await qbFetch(
    `/invoice?operation=void`,
    { method: 'POST', body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken }) },
    db,
  );
  return { voided: true };
}

// The terms saved on the customer's QB account (their default SalesTermRef).
// Returned as a Term Id so we can stamp it onto the invoice explicitly —
// QB does not always carry the customer default onto API-created invoices.
export async function getCustomerSalesTermId(qbCustomerId: string): Promise<string | null> {
  try {
    const res = await qbFetch<{ Customer?: { SalesTermRef?: { value?: string } } }>(
      `/customer/${encodeURIComponent(qbCustomerId)}`,
    );
    return res.Customer?.SalesTermRef?.value ?? null;
  } catch (e) {
    console.warn('getCustomerSalesTermId failed:', e);
    return null;
  }
}

// All sales terms defined in QuickBooks, for the order-placement dropdown.
export type SalesTerm = { id: string; name: string; dueDays: number | null };
export async function listSalesTerms(): Promise<SalesTerm[]> {
  const res = await qbFetch<{ QueryResponse: { Term?: Array<{ Id: string; Name?: string; DueDays?: number; Active?: boolean }> } }>(
    `/query?query=${encodeURIComponent('select Id, Name, DueDays, Active from Term maxresults 500')}`,
  );
  return (res.QueryResponse.Term || [])
    .filter((t) => t.Active !== false)
    .map((t) => ({ id: t.Id, name: t.Name || `Term ${t.Id}`, dueDays: t.DueDays ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Customer billing history ─────────────────────────────────────────────────
// Returns the items this QB customer has been billed for in their recent
// invoices, keyed by item id. Most-recent UnitPrice wins.
export type HistoryItem = {
  qbItemId: string;
  qbItemName: string;
  lastUnitPrice: number;
  timesBilled: number;
};

export async function getCustomerHistoryItems(qbCustomerId: string, maxInvoices = 20): Promise<HistoryItem[]> {
  try {
    const q = `select * from Invoice where CustomerRef = '${qbCustomerId}' orderby TxnDate desc maxresults ${maxInvoices}`;
    const res = await qbFetch<{ QueryResponse: { Invoice?: Array<any> } }>(
      `/query?query=${encodeURIComponent(q)}`,
    );
    const invoices = res.QueryResponse.Invoice || [];
    const byId = new Map<string, HistoryItem>();
    for (const inv of invoices) {
      const lines: any[] = inv.Line || [];
      for (const line of lines) {
        if (line.DetailType !== 'SalesItemLineDetail') continue;
        const ref = line.SalesItemLineDetail?.ItemRef;
        const id = ref?.value;
        if (!id) continue;
        const name = ref?.name ?? '';
        const price = Number(line.SalesItemLineDetail?.UnitPrice ?? 0);
        const existing = byId.get(id);
        if (existing) {
          existing.timesBilled++;
          // We iterate invoices in date-desc order, so the FIRST price we
          // see is the most recent. Don't overwrite.
        } else {
          byId.set(id, {
            qbItemId: id,
            qbItemName: name,
            lastUnitPrice: price,
            timesBilled: 1,
          });
        }
      }
    }
    return Array.from(byId.values());
  } catch (e) {
    console.warn('getCustomerHistoryItems failed:', e);
    return [];
  }
}

// ── List a customer's invoices ──────────────────────────────────────────────
// The header data for a customer's recent invoices (newest first), so the admin
// can browse and pull up the PDF of any one. QuickBooks keeps these forever, so
// it doubles as the customer's invoice archive.
export type CustomerInvoiceSummary = {
  id: string;
  docNumber: string | null;
  txnDate: string | null;
  total: number;
  balance: number;
};

export async function listCustomerInvoices(
  qbCustomerId: string,
  max = 100,
): Promise<CustomerInvoiceSummary[]> {
  const q = `select Id, DocNumber, TxnDate, TotalAmt, Balance from Invoice where CustomerRef = '${qbCustomerId}' orderby TxnDate desc maxresults ${max}`;
  const res = await qbFetch<{ QueryResponse: { Invoice?: Array<Record<string, unknown>> } }>(
    `/query?query=${encodeURIComponent(q)}`,
  );
  return (res.QueryResponse.Invoice || []).map((inv) => ({
    id: String(inv.Id),
    docNumber: inv.DocNumber != null ? String(inv.DocNumber) : null,
    txnDate: inv.TxnDate != null ? String(inv.TxnDate) : null,
    total: Number(inv.TotalAmt ?? 0),
    balance: Number(inv.Balance ?? 0),
  }));
}

// ── Fetch the rendered invoice PDF from QB ──────────────────────────────────
// QB returns a binary PDF; we hand back a Uint8Array the caller can upload
// to storage.
export async function fetchInvoicePdf(invoiceId: string): Promise<Uint8Array> {
  const { accessToken, realmId, environment } = await getValidAccessToken();
  const host = environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
  const url = `${host}/v3/company/${realmId}/invoice/${encodeURIComponent(invoiceId)}/pdf`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/pdf',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks invoice PDF download failed: ${res.status} ${text}`);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

// Attach a file (PDF or image) to a QuickBooks invoice via the Attachable
// /upload API. IncludeOnSend ticks the "Attach to email" box. Best-effort:
// callers should not fail the invoice if this throws.
export async function attachFileToInvoice(
  invoiceId: string,
  fileBytes: Uint8Array,
  fileName: string,
  contentType: string,
  db?: SupabaseClient,
): Promise<void> {
  const { accessToken, apiBase } = await getQbApiContext(db);
  const metadata = {
    AttachableRef: [{ EntityRef: { type: 'Invoice', value: invoiceId }, IncludeOnSend: true }],
    FileName: fileName,
    ContentType: contentType,
  };
  const form = new FormData();
  form.append('file_metadata_01', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('file_content_01', new Blob([fileBytes as BlobPart], { type: contentType }), fileName);
  const res = await fetch(`${apiBase}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks attachment upload failed: ${res.status} ${text}`);
  }
}

// ── Edit an existing invoice ────────────────────────────────────────────────
// A QB invoice line (sales-item) as returned by the API.
export type QBInvoiceLine = {
  Id?: string;
  LineNum?: number;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  SalesItemLineDetail?: {
    ItemRef?: { value: string; name?: string };
    Qty?: number;
    UnitPrice?: number;
  };
};

export type QBFullInvoice = {
  Id: string;
  DocNumber?: string;
  SyncToken: string;
  TotalAmt?: number;
  TxnDate?: string;
  Line?: QBInvoiceLine[];
  CustomerRef?: { value: string; name?: string };
  TxnTaxDetail?: unknown;
};

// Post an invoice update, transparently recovering from QB error 6270
// ("Transaction date is prior to start date for inventory item"). That happens
// when an invoice dated in the past gets a newly-added inventory product whose
// QuickBooks Inventory Start (as-of) date is later than the invoice date. We
// retry once with the transaction date bumped to today, which satisfies the
// constraint without otherwise changing the invoice.
async function postInvoiceUpdate(body: Record<string, unknown>): Promise<QBFullInvoice> {
  try {
    const res = await qbFetch<{ Invoice: QBFullInvoice }>('/invoice', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.Invoice;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/6270|prior to start date/i.test(msg)) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const res = await qbFetch<{ Invoice: QBFullInvoice }>('/invoice', {
        method: 'POST',
        body: JSON.stringify({ ...body, TxnDate: today }),
      });
      return res.Invoice;
    }
    throw e;
  }
}

// Find a full invoice (with lines + SyncToken) by its DocNumber.
export async function getInvoiceByDocNumber(docNumber: string): Promise<QBFullInvoice | null> {
  const escaped = docNumber.replace(/'/g, "''");
  const query = `select * from Invoice where DocNumber = '${escaped}'`;
  const res = await qbFetch<{ QueryResponse?: { Invoice?: QBFullInvoice[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
  );
  return res.QueryResponse?.Invoice?.[0] ?? null;
}

// Get a full invoice by its QB Id.
export async function getInvoiceById(invoiceId: string): Promise<QBFullInvoice | null> {
  const res = await qbFetch<{ Invoice?: QBFullInvoice }>(`/invoice/${encodeURIComponent(invoiceId)}`);
  return res.Invoice ?? null;
}

// Update qty/unit price on existing sales-item lines of an invoice. `edits` is
// keyed by the QB line Id. Non-sales lines (e.g. tax) are left untouched.
// Uses a full update (QB recalculates Amount/total). Returns the updated invoice.
export async function updateInvoiceLines(
  inv: QBFullInvoice,
  edits: Record<string, { qty?: number; unitPrice?: number }>,
): Promise<QBFullInvoice> {
  const Line = (inv.Line || []).map((l) => {
    if (l.DetailType !== 'SalesItemLineDetail' || !l.Id || !edits[l.Id]) return l;
    const e = edits[l.Id];
    const qty = e.qty ?? l.SalesItemLineDetail?.Qty ?? 0;
    const unitPrice = e.unitPrice ?? l.SalesItemLineDetail?.UnitPrice ?? 0;
    return {
      ...l,
      Amount: qbLineAmount(unitPrice, qty),
      SalesItemLineDetail: { ...l.SalesItemLineDetail, Qty: qty, UnitPrice: unitPrice },
    };
  });
  // QB requires CustomerRef on an invoice update (error 6560 otherwise). Send
  // it (and the tax detail, if present) from the fetched invoice so QB keeps
  // the customer + recomputes tax/total from the edited lines.
  if (!inv.CustomerRef?.value) {
    throw new Error('Invoice is missing CustomerRef — cannot update. Re-sync the customer/invoice.');
  }
  const body: Record<string, unknown> = {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
    sparse: true,
    CustomerRef: inv.CustomerRef,
    Line,
  };
  return postInvoiceUpdate(body);
}

// Rebuild an invoice's sales-item lines from a desired set: existing lines kept
// by their QB line `id` (with edited qty/price/item), new lines (no id) added,
// and any existing line NOT in the set is dropped (deleted). Non-sales lines
// (e.g. tax) on the original are preserved. CustomerRef is required by QB.
export type DesiredLine = {
  id?: string;            // existing QB line id (omit for a new line)
  qbItemId: string;
  qbItemName: string;
  qty: number;
  unitPrice: number;
  taxLine?: boolean;      // sub-cent tax/fee: send Amount+Qty, let QB derive rate
};
export async function rebuildInvoiceLines(
  inv: QBFullInvoice,
  desired: DesiredLine[],
  taxable?: boolean,
): Promise<QBFullInvoice> {
  if (!inv.CustomerRef?.value) {
    throw new Error('Invoice is missing CustomerRef — cannot update. Re-sync the customer/invoice.');
  }
  // Keep original non-sales lines (tax, discounts, subtotals) untouched.
  const keptNonSales = (inv.Line || []).filter((l) => l.DetailType !== 'SalesItemLineDetail');
  const salesLines = desired.map((d) => {
    // Round a tax/fee rate to 5 decimals (QB's max) and derive the Amount
    // from it, so the rate prints AND Amount = Qty × UnitPrice holds (no 6070).
    const rate = d.taxLine ? Math.round(d.unitPrice * 1e5) / 1e5 : d.unitPrice;
    const amount = qbLineAmount(rate, d.qty);
    const detail: QBInvoiceLine['SalesItemLineDetail'] = {
      ItemRef: { value: d.qbItemId, name: d.qbItemName },
      Qty: d.qty,
    };
    // Send the unit price on every line (incl. tax lines) so the rate prints.
    detail!.UnitPrice = rate;
    // Never sales-tax a tax/fee line, even on an edit. Otherwise, when a
    // taxable flag is given, mark the line TAX/NON so an adjuster can add (or
    // remove) sales tax.
    if (d.taxLine) {
      (detail as Record<string, unknown>).TaxCodeRef = { value: 'NON' };
    } else if (taxable !== undefined) {
      (detail as Record<string, unknown>).TaxCodeRef = { value: taxable ? 'TAX' : 'NON' };
    }
    const base: QBInvoiceLine = {
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: d.qbItemName,
      SalesItemLineDetail: detail,
    };
    if (d.id) base.Id = d.id; // keep the existing line identity when present
    return base;
  });
  const body: Record<string, unknown> = {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
    sparse: false,
    CustomerRef: inv.CustomerRef,
    Line: [...salesLines, ...keptNonSales],
  };
  return postInvoiceUpdate(body);
}

// Look up QB items by their exact Name field. Returns a map keyed by name.
// Items that aren't found are simply omitted (with a console warn) so the
// invoice creation can still proceed.
export async function findItemsByNames(names: string[]): Promise<Record<string, QBItem>> {
  const result: Record<string, QBItem> = {};
  // Query in small batches using IN clause — QB supports up to ~10 names per IN.
  const batchSize = 10;
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    const escaped = batch.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
    const query = `select * from Item where Name in (${escaped})`;
    try {
      const res = await qbFetch<{ QueryResponse: { Item?: QBItem[] } }>(
        `/query?query=${encodeURIComponent(query)}`,
      );
      for (const it of res.QueryResponse.Item || []) {
        result[it.Name] = it;
      }
    } catch (e) {
      console.warn('findItemsByNames batch failed:', e);
    }
  }
  return result;
}

// ── List all active items (for the admin mapping UI) ─────────────────────────
export async function listAllItems(): Promise<QBItem[]> {
  const all: QBItem[] = [];
  let startPosition = 1;
  const pageSize = 100;
  while (true) {
    const q = `select * from Item where Active = true startposition ${startPosition} maxresults ${pageSize}`;
    const res = await qbFetch<{ QueryResponse: { Item?: QBItem[] } }>(
      `/query?query=${encodeURIComponent(q)}`,
    );
    const batch = res.QueryResponse.Item || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }
  return all;
}

// ── QuickBooks Classes (used to tag invoice lines per salesman) ──────────────
export type QBClass = { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean };

export async function listClasses(): Promise<QBClass[]> {
  const all: QBClass[] = [];
  let startPosition = 1;
  const pageSize = 200;
  while (true) {
    const q = `select * from Class where Active in (true, false) startposition ${startPosition} maxresults ${pageSize}`;
    const res = await qbFetch<{ QueryResponse: { Class?: QBClass[] } }>(`/query?query=${encodeURIComponent(q)}`);
    const batch = res.QueryResponse.Class || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }
  return all;
}


// ── For surfaced UI: get the customer's negotiated price for an item ─────────
// QB stores price overrides via "PriceLevel" objects. We don't fully model
// that here; the common case is the customer has no price level and the
// default UnitPrice on the item is used. If you need negotiated prices later,
// extend this to look up PriceLevelPerItem.
export async function getItemUnitPrice(qbItemId: string): Promise<number | null> {
  try {
    const res = await qbFetch<{ Item: QBItem }>(`/item/${encodeURIComponent(qbItemId)}`);
    return res.Item.UnitPrice ?? null;
  } catch {
    return null;
  }
}

// ── Nightly balance sync ─────────────────────────────────────────────────────
// Refreshes cached qb_balance + qb_oldest_open_invoice_date (and payment
// method / terms) on every Business that has a qb_customer_id. Two bulk QB
// queries do the work regardless of customer count. `db` lets a cron job pass
// a service-role client; the admin button passes its cookie client.
export async function syncQbBalances(
  db: SupabaseClient,
): Promise<{ synced: number; total: number }> {
  const { data: businesses } = await db
    .from('businesses')
    .select('id, qb_customer_id')
    .not('qb_customer_id', 'is', null);
  const byQbId = new Map<string, string>(); // qb_customer_id -> our business id
  for (const b of businesses || []) {
    if (b.qb_customer_id) byQbId.set(b.qb_customer_id, b.id);
  }
  if (byQbId.size === 0) return { synced: 0, total: 0 };

  type QBCust = {
    Id: string;
    Balance: number;
    PaymentMethodRef?: { value: string };
    SalesTermRef?: { value: string };
  };
  const customerBalances = new Map<string, number>();
  const customerPmId = new Map<string, string>();
  const customerTermId = new Map<string, string>();
  let startPosition = 1;
  const PAGE = 1000;
  for (;;) {
    // Include inactive ("deleted") customers — QB excludes them by default, so
    // a deactivated customer that still owes money would otherwise sync as $0.
    const query = `select Id, DisplayName, Balance, PaymentMethodRef, SalesTermRef from Customer where Active in (true, false) startposition ${startPosition} maxresults ${PAGE}`;
    const res = await qbFetch<{ QueryResponse: { Customer?: QBCust[] } }>(
      `/query?query=${encodeURIComponent(query)}`,
      undefined,
      db,
    );
    const batch = res.QueryResponse.Customer || [];
    for (const c of batch) {
      customerBalances.set(c.Id, Number(c.Balance) || 0);
      if (c.PaymentMethodRef?.value) customerPmId.set(c.Id, c.PaymentMethodRef.value);
      if (c.SalesTermRef?.value) customerTermId.set(c.Id, c.SalesTermRef.value);
    }
    if (batch.length < PAGE) break;
    startPosition += PAGE;
  }

  const pmById = new Map<string, string>();
  const termById = new Map<string, string>();
  try {
    const pmRes = await qbFetch<{ QueryResponse: { PaymentMethod?: Array<{ Id: string; Name: string }> } }>(
      `/query?query=${encodeURIComponent('select * from PaymentMethod maxresults 500')}`,
      undefined,
      db,
    );
    for (const pm of pmRes.QueryResponse.PaymentMethod || []) pmById.set(pm.Id, pm.Name);
  } catch (e) { console.warn('PaymentMethod lookup failed:', e); }
  try {
    const termRes = await qbFetch<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>(
      `/query?query=${encodeURIComponent('select * from Term maxresults 500')}`,
      undefined,
      db,
    );
    for (const t of termRes.QueryResponse.Term || []) termById.set(t.Id, t.Name);
  } catch (e) { console.warn('Term lookup failed:', e); }

  type QBInv = { TxnDate: string; CustomerRef: { value: string } };
  const oldestByCustomer = new Map<string, string>();
  startPosition = 1;
  for (;;) {
    const query = `select Id, TxnDate, Balance, CustomerRef from Invoice where Balance > '0' orderby TxnDate asc startposition ${startPosition} maxresults ${PAGE}`;
    const res = await qbFetch<{ QueryResponse: { Invoice?: QBInv[] } }>(
      `/query?query=${encodeURIComponent(query)}`,
      undefined,
      db,
    );
    const batch = res.QueryResponse.Invoice || [];
    for (const inv of batch) {
      const cid = inv.CustomerRef?.value;
      if (cid && !oldestByCustomer.has(cid)) oldestByCustomer.set(cid, inv.TxnDate);
    }
    if (batch.length < PAGE) break;
    startPosition += PAGE;
  }

  // Most recent invoice per customer = "last purchase". Scan newest-first and
  // keep the first date we see for each customer. Bounded by a scan cap and an
  // early exit (once every tracked customer has a date) so a long invoice
  // history can't blow the 60s budget.
  const lastPurchaseByCustomer = new Map<string, string>();
  // Also keep recent invoice dates per customer (newest-first) for the
  // order-cadence / past-orders panel on /admin/customers. Best-effort: we
  // collect up to RECENT_LIMIT during the same newest-first scan and don't
  // extend it, so the cost matches the existing last-purchase scan. 24 dates
  // covers a 12-month rolling window for all but the most frequent buyers.
  const RECENT_LIMIT = 24;
  const recentByCustomer = new Map<string, string[]>();
  // Never let a problem gathering last-purchase dates abort the balance sync —
  // we still want balances + oldest-invoice written. Worst case the dates stay
  // null this run.
  try {
    const MAX_INVOICE_SCAN = 5000;
    let scanned = 0;
    startPosition = 1;
    for (;;) {
      const query = `select Id, TxnDate, CustomerRef from Invoice orderby TxnDate desc startposition ${startPosition} maxresults ${PAGE}`;
      const res = await qbFetch<{ QueryResponse: { Invoice?: QBInv[] } }>(
        `/query?query=${encodeURIComponent(query)}`,
        undefined,
        db,
      );
      const batch = res.QueryResponse.Invoice || [];
      for (const inv of batch) {
        const cid = inv.CustomerRef?.value;
        if (!cid) continue;
        if (!lastPurchaseByCustomer.has(cid)) lastPurchaseByCustomer.set(cid, inv.TxnDate);
        const list = recentByCustomer.get(cid);
        if (!list) recentByCustomer.set(cid, [inv.TxnDate]);
        else if (list.length < RECENT_LIMIT) list.push(inv.TxnDate);
      }
      scanned += batch.length;
      if (batch.length < PAGE || scanned >= MAX_INVOICE_SCAN) break;
      // Stop early once every tracked business has at least its last-purchase
      // date — same exit as before, so we don't add scan cost.
      let allFound = true;
      for (const qbId of byQbId.keys()) {
        if (!lastPurchaseByCustomer.has(qbId)) { allFound = false; break; }
      }
      if (allFound) break;
      startPosition += PAGE;
    }
  } catch (e) {
    console.warn('last-purchase scan failed:', e);
  }

  const now = new Date().toISOString();
  const updates = Array.from(byQbId).map(([qbId, businessId]) => {
    const pmId = customerPmId.get(qbId);
    const termId = customerTermId.get(qbId);
    return db
      .from('businesses')
      .update({
        qb_balance: customerBalances.get(qbId) ?? 0,
        qb_oldest_open_invoice_date: oldestByCustomer.get(qbId) ?? null,
        qb_last_purchase_date: lastPurchaseByCustomer.get(qbId) ?? null,
        qb_recent_invoice_dates: recentByCustomer.get(qbId) ?? null,
        qb_payment_method: pmId ? (pmById.get(pmId) ?? null) : null,
        qb_payment_terms: termId ? (termById.get(termId) ?? null) : null,
        qb_balance_synced_at: now,
      })
      .eq('id', businessId);
  });
  const results = await Promise.allSettled(updates);
  let synced = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && !r.value.error) synced += 1;
  }
  return { synced, total: byQbId.size };
}

// ── Sync specific QB customers into profiles (used by the webhook) ───────────
// Fetches the given QB customer Ids and upserts each into public.profiles,
// matching first by existing QB link, then by email, otherwise creating a new
// "imported" customer profile (no auth.users row). Mirrors the batch sync's
// matching rules but only for the ids that changed.
type QBCustomerFull = {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: {
    Line1?: string;
    Line2?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
  };
};

function formatQbAddress(a: QBCustomerFull['BillAddr']): string | null {
  if (!a) return null;
  const parts = [
    a.Line1,
    a.Line2,
    [a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(', '),
  ].filter(Boolean);
  return parts.join('\n') || null;
}

export async function syncQbCustomersByIds(
  db: SupabaseClient,
  ids: string[],
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0, updated = 0, skipped = 0;
  const unique = Array.from(new Set(ids.filter(Boolean)));

  for (const id of unique) {
    let c: QBCustomerFull | null = null;
    try {
      const res = await qbFetch<{ Customer?: QBCustomerFull }>(
        `/customer/${encodeURIComponent(id)}`,
        undefined,
        db,
      );
      c = res.Customer ?? null;
    } catch (e) {
      console.warn('QB webhook customer fetch failed for', id, e);
    }
    if (!c) { skipped++; continue; }

    const email = c.PrimaryEmailAddr?.Address?.trim() || null;
    const businessName = c.CompanyName?.trim() || c.DisplayName?.trim() || null;
    const fullName =
      c.DisplayName && c.CompanyName && c.DisplayName !== c.CompanyName
        ? c.DisplayName.trim()
        : null;
    const phone = c.PrimaryPhone?.FreeFormNumber?.trim() || null;
    const address = formatQbAddress(c.BillAddr);
    if (!businessName && !email) { skipped++; continue; }

    // (a) Already linked by QB id?
    const { data: byLink } = await db
      .from('profiles').select('id').eq('imported_from_qb_customer_id', c.Id).maybeSingle();
    if (byLink) {
      await db.from('profiles').update({
        business_name: businessName,
        full_name: fullName,
        email: email ?? `qb-${c.Id}@stallion.local`,
        phone, address,
      }).eq('id', byLink.id);
      await db.from('customer_qb_mapping').upsert({
        profile_id: byLink.id, qb_customer_id: c.Id,
        qb_customer_name: c.DisplayName || c.CompanyName || '', updated_at: new Date().toISOString(),
      });
      updated++;
      continue;
    }

    // (b) Same email — adopt only if not already tied to a different QB
    //     customer (two QB customers can share an email; don't merge them).
    if (email) {
      const { data: emailMatches } = await db
        .from('profiles').select('id, imported_from_qb_customer_id').eq('email', email);
      const adopt =
        (emailMatches || []).find((p) => p.imported_from_qb_customer_id === c.Id) ||
        (emailMatches || []).find((p) => !p.imported_from_qb_customer_id);
      if (adopt) {
        await db.from('profiles').update({
          business_name: businessName,
          full_name: fullName ?? undefined,
          phone: phone ?? undefined,
          address: address ?? undefined,
          imported_from_qb_customer_id: c.Id,
        }).eq('id', adopt.id);
        await db.from('customer_qb_mapping').upsert({
          profile_id: adopt.id, qb_customer_id: c.Id,
          qb_customer_name: c.DisplayName || c.CompanyName || '', updated_at: new Date().toISOString(),
        });
        updated++;
        continue;
      }
    }

    // (c) Brand-new imported profile (no auth.users row)
    const newId = randomUUID();
    const { error: insErr } = await db.from('profiles').insert({
      id: newId,
      email: email ?? `qb-${c.Id}@stallion.local`,
      full_name: fullName,
      business_name: businessName,
      phone, address,
      role: 'customer',
      imported_from_qb_customer_id: c.Id,
      must_change_password: false,
    });
    if (insErr) { console.error('QB webhook insert failed for', c.Id, insErr.message); skipped++; continue; }
    await db.from('customer_qb_mapping').upsert({
      profile_id: newId, qb_customer_id: c.Id,
      qb_customer_name: c.DisplayName || c.CompanyName || '', updated_at: new Date().toISOString(),
    });
    created++;
  }
  return { created, updated, skipped };
}
