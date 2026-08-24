// Minimal Plaid client (REST via fetch — no SDK dependency). Handles the Link
// connect flow (create link token → exchange for an access token) and pulling
// recent card transactions so they can be reconciled against receipts.
//
// Credentials (Vercel env):
//   PLAID_CLIENT_ID, PLAID_SECRET
//   PLAID_ENV          — 'sandbox' | 'development' | 'production' (default production)
//   PLAID_ACCESS_TOKEN — optional fallback token(s), comma-separated. Cards
//                        linked via the "Connect a card" button are stored in
//                        public.plaid_items instead, so this is rarely needed.
//
// Never import this from a client component — access tokens must not reach the
// browser.

export type PlaidCharge = {
  transactionId: string;
  date: string | null;      // yyyy-mm-dd
  amount: number;           // positive = money out (a charge)
  merchant: string | null;
  last4: string | null;
  cardholder: string | null;
};

// Credentials present? (An access token can come from a linked card in the DB,
// so it's not part of this check.)
export function plaidCredsConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

// Optional env-configured access tokens (comma-separated). Linked cards live in
// public.plaid_items; these are merged in by the sync as a fallback.
export function envAccessTokens(): string[] {
  return (process.env.PLAID_ACCESS_TOKEN || '')
    .split(',').map((t) => t.trim()).filter(Boolean);
}

function plaidHost(): string {
  const env = (process.env.PLAID_ENV || 'production').toLowerCase();
  return `https://${env}.plaid.com`;
}

async function plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${plaidHost()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body,
    }),
    cache: 'no-store',
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error_message || json?.error_code || `HTTP ${res.status}`;
    throw new Error(`Plaid ${path}: ${msg}`);
  }
  return json as T;
}

// ── Link connect flow ────────────────────────────────────────────────────────

// Create a short-lived link_token the browser uses to open Plaid Link.
export async function createLinkToken(userId: string): Promise<string> {
  const json = await plaidPost<{ link_token: string }>('/link/token/create', {
    user: { client_user_id: userId },
    client_name: 'Auto 1 Oil',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });
  return json.link_token;
}

// Exchange the public_token from a successful Link for a permanent access token.
export async function exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
  const json = await plaidPost<{ access_token: string; item_id: string }>(
    '/item/public_token/exchange',
    { public_token: publicToken },
  );
  return { accessToken: json.access_token, itemId: json.item_id };
}

// ── Transactions ─────────────────────────────────────────────────────────────

type PlaidAccount = { account_id: string; mask?: string | null };
type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date?: string | null;
  authorized_date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
};

async function fetchChargesForToken(token: string, since: string, today: string): Promise<PlaidCharge[]> {
  // Account masks (last 4) so charges can be mapped to a card -> driver.
  const accts = await plaidPost<{ accounts: PlaidAccount[] }>('/accounts/get', { access_token: token });
  const maskById = new Map<string, string | null>();
  for (const a of accts.accounts) maskById.set(a.account_id, a.mask ?? null);

  const out: PlaidCharge[] = [];
  let offset = 0;
  const count = 250;
  while (true) {
    const page = await plaidPost<{ transactions: PlaidTxn[]; total_transactions: number }>(
      '/transactions/get',
      { access_token: token, start_date: since, end_date: today, options: { count, offset } },
    );
    for (const t of page.transactions) {
      // Plaid convention: positive amount = money leaving the account (a charge).
      if (typeof t.amount !== 'number' || t.amount <= 0) continue;
      out.push({
        transactionId: t.transaction_id,
        date: t.authorized_date || t.date || null,
        amount: Math.round(t.amount * 100) / 100,
        merchant: t.merchant_name || t.name || null,
        last4: maskById.get(t.account_id) ?? null,
        cardholder: null,
      });
    }
    offset += page.transactions.length;
    if (offset >= page.total_transactions || page.transactions.length === 0) break;
  }
  return out;
}

// Pull charges in [since, today] across every provided access token.
export async function fetchPlaidCharges(tokens: string[], since: string, today: string): Promise<PlaidCharge[]> {
  const out: PlaidCharge[] = [];
  for (const token of tokens) {
    out.push(...(await fetchChargesForToken(token, since, today)));
  }
  return out;
}
