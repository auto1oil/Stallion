// Card-charge reconciliation: pull charges from Plaid, attribute each to a
// driver via card_driver_map, then match it to a receipt read from the
// fuel/vehicle app by amount + date. Both integrations degrade gracefully — with
// neither configured this is a no-op that reports what's still unwired.

import { createAdminClient } from '@/lib/supabase-admin';
import { fetchPlaidCharges, plaidCredsConfigured, envAccessTokens } from '@/lib/plaid';
import { fetchExternalReceipts, receiptsConfigured, type ExternalReceipt } from '@/lib/receipts-source';
import { fetchCreditCardPurchases, listCreditCardAccounts } from '@/lib/quickbooks';

export type SyncResult = {
  configured: { plaid: boolean; receipts: boolean; quickbooks: boolean };
  pulled: number;    // new charges inserted from Plaid
  qbPulled: number;  // new charges inserted from QuickBooks
  matched: number;   // charges newly matched to a receipt
  missing: number;   // charges still without a receipt
  qbError?: string | null;  // surfaced QB query failure (else silent 0-pull)
};

const DAY = 86400000;

// Match tolerance: same amount within a cent, date within +/- 2 days (a receipt
// is often dated a day off from when the charge posts).
function receiptMatches(
  charge: { amount: number | null; charge_date: string | null },
  r: ExternalReceipt,
): boolean {
  if (charge.amount == null || r.amount == null) return false;
  if (Math.abs(charge.amount - r.amount) > 0.011) return false;
  if (!charge.charge_date || !r.date) return false;
  const gap = Math.abs(new Date(charge.charge_date).getTime() - new Date(r.date).getTime());
  return gap <= 2 * DAY;
}

export async function syncCardCharges(lookbackDays = 60): Promise<SyncResult> {
  const db = createAdminClient();
  const now = Date.now();
  const since = new Date(now - lookbackDays * DAY).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);

  // Access tokens: cards linked via the Connect button (plaid_items) plus any
  // env fallback. Plaid is "ready" only with creds AND at least one linked card.
  const { data: items, error: itemsErr } = await db.from('plaid_items').select('access_token');
  const dbTokens = itemsErr ? [] : (items || []).map((i) => i.access_token as string).filter(Boolean);
  const tokens = Array.from(new Set([...envAccessTokens(), ...dbTokens]));
  const plaidReady = plaidCredsConfigured() && tokens.length > 0;

  // Driver attribution for Plaid charges: card_last4 (+ optional
  // cardholder) → driver_id, from card_driver_map.
  const { data: maps } = await db
    .from('card_driver_map')
    .select('card_last4, cardholder_name, driver_id');
  const driverFor = (last4: string | null, holder: string | null): string | null => {
    if (!last4) return null;
    const rows = (maps || []).filter((m) => m.card_last4 === last4);
    const exact = rows.find(
      (m) => m.cardholder_name && holder && m.cardholder_name.toLowerCase() === holder.toLowerCase(),
    );
    const any = rows.find((m) => !m.cardholder_name);
    return (exact || any)?.driver_id ?? null;
  };

  // 1) Pull charges from Plaid and insert new ones (dedupe on external_id).
  let pulled = 0;
  if (plaidReady) {
    const charges = await fetchPlaidCharges(tokens, since, today);
    for (const c of charges) {
      const { data: existing } = await db
        .from('card_charges').select('id').eq('external_id', c.transactionId).maybeSingle();
      if (existing) continue;
      const { error } = await db.from('card_charges').insert({
        source: 'plaid',
        external_id: c.transactionId,
        card_last4: c.last4,
        cardholder_name: c.cardholder,
        merchant: c.merchant,
        amount: c.amount,
        charge_date: c.date,
        driver_id: driverFor(c.last4, c.cardholder),
        receipt_status: 'missing',
      });
      if (!error) pulled++;
    }
  }

  // 1c) QuickBooks credit-card charges — the bank truth for what actually hit
  //     the cards. QB Purchases (PaymentType='CreditCard') carry no last-4 or
  //     cardholder, so attribution is best-effort: parse a trailing 4-digit
  //     last-4 out of the account name for the card→driver map; otherwise a
  //     matched receipt (step 2) fills in the driver.
  const { data: qbConn } = await db.from('quickbooks_connection').select('id').eq('id', 1).maybeSingle();
  const qbConnected = !!qbConn;
  let qbPulled = 0;
  let qbError: string | null = null;
  if (qbConnected) {
    // Time-aware attribution: each card belongs to a truck; the driver on that
    // truck changes over time. A charge on card X dated D → the assignment for X
    // with the latest effective_from <= D. (Rows are sorted newest-first, so the
    // first match is the one in effect on the charge date.)
    const { data: assigns } = await db.from('card_assignments')
      .select('card_last4, driver_id, effective_from')
      .order('effective_from', { ascending: false });
    const assignList = ((assigns as { card_last4: string; driver_id: string | null; effective_from: string }[]) || []);
    const driverForCardDate = (last4: string | null, date: string | null): string | null => {
      if (!last4) return null;
      const forCard = assignList.filter((a) => a.card_last4 === last4); // newest-first
      if (!forCard.length) return null;
      // The assignment in effect on the charge date (latest effective_from <= date).
      if (date) {
        const hit = forCard.find((a) => a.effective_from <= date);
        if (hit) return hit.driver_id ?? null;
      }
      // Charge predates every assignment (e.g. you assigned the card today but
      // it has charges from last week) → fall back to the earliest assignment,
      // so the card's driver still covers its existing charges.
      return forCard[forCard.length - 1].driver_id ?? null;
    };

    // Restrict to the credit-card account(s) the admin picked (comma-separated
    // QB account ids in app_settings). With no explicit pick, default to every
    // *active* credit-card account — never all Purchases — so charges posted to
    // closed/deleted accounts (whose historical Purchases still live in QB, and
    // show up named "(deleted)") are never pulled.
    const { data: acctSetting } = await db.from('app_settings').select('value').eq('key', 'card_charge_account_ids').maybeSingle();
    let acctIds = String((acctSetting as { value?: string } | null)?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!acctIds.length) {
      try {
        const active = await listCreditCardAccounts(db);
        acctIds = active.map((a) => a.id);
      } catch {
        // Couldn't list accounts — don't fail the whole sync; fall through and
        // let the Purchase query below run unfiltered.
      }
    }
    // Only pull charges booked to the holding account you auto-add into
    // (default "APP Receipts Pending"). Blank the setting to pull every charge.
    const { data: expSetting } = await db.from('app_settings').select('value').eq('key', 'card_charge_expense_account').maybeSingle();
    const expenseAccount = expSetting == null
      ? 'APP Receipts Pending'                                  // unset → sensible default
      : String((expSetting as { value?: string }).value || '').trim();
    try {
      const purchases = await fetchCreditCardPurchases(since, acctIds.length ? acctIds : undefined, db, expenseAccount || undefined);
      for (const p of purchases) {
        const extId = `qb:${p.id}`;
        const { data: existing } = await db.from('card_charges').select('id').eq('external_id', extId).maybeSingle();
        if (existing) continue;
        const last4 = p.accountName?.match(/(\d{4})(?!.*\d)/)?.[1] ?? null;
        const { error } = await db.from('card_charges').insert({
          source: 'quickbooks',
          external_id: extId,
          card_last4: last4,
          merchant: p.merchant ?? p.accountName,
          amount: p.amount,
          charge_date: p.date,
          driver_id: driverForCardDate(last4, p.date),
          receipt_status: 'missing',
        });
        if (!error) qbPulled++;
      }
    } catch (e) {
      // QB query failed (not connected / permissions / bad query) — surface it
      // instead of silently pulling 0, and let other sources still run.
      qbError = e instanceof Error ? e.message : String(e);
    }

    // Re-attribute existing QB charges from the current assignments, so editing
    // a card's driver (or adding a dated reassignment) fixes historical charges
    // by date on the next sync.
    const { data: qbCharges } = await db.from('card_charges')
      .select('id, card_last4, charge_date, driver_id')
      .eq('source', 'quickbooks');
    for (const c of ((qbCharges as { id: string; card_last4: string | null; charge_date: string | null; driver_id: string | null }[]) || [])) {
      const want = driverForCardDate(c.card_last4, c.charge_date);
      if (want && want !== c.driver_id) {
        await db.from('card_charges').update({ driver_id: want }).eq('id', c.id);
      }
    }
  }

  // 2) Match still-missing charges against external receipts. OneGloveBox is
  //    wired here (as the receipts/explanation source via RECEIPTS_API_URL/KEY):
  //    its driver-uploaded receipts match onto real bank charges by amount+date,
  //    so a bank charge with no matching upload stays "missing" — that's an
  //    unexplained charge. A match also attributes the charge to whoever
  //    uploaded the receipt (QB charges arrive with no driver).
  let matched = 0;
  if (receiptsConfigured()) {
    const receipts = await fetchExternalReceipts(since);
    // Resolve a receipt's driver name → an Auto 1 profile (whole name, then
    // unambiguous first name — OneGloveBox often sends just a first name).
    const { data: allProfs } = await db.from('profiles').select('id, full_name');
    const profList = ((allProfs as { id: string; full_name: string | null }[]) || []);
    const driverIdByName = (name: string | null): string | null => {
      const n = (name || '').trim().toLowerCase();
      if (!n) return null;
      const full = profList.filter((p) => (p.full_name || '').trim().toLowerCase() === n);
      if (full.length === 1) return full[0].id;
      const first = profList.filter((p) => (p.full_name || '').trim().toLowerCase().split(/\s+/)[0] === n);
      return first.length === 1 ? first[0].id : null;
    };
    const { data: open } = await db
      .from('card_charges')
      .select('id, amount, charge_date, driver_id')
      .eq('receipt_status', 'missing');
    const used = new Set<string>();
    for (const charge of open || []) {
      const hit = receipts.find((r) => r.id && !used.has(r.id) && receiptMatches(charge, r));
      if (!hit) continue;
      used.add(hit.id);
      const update: Record<string, unknown> = {
        receipt_status: 'matched',
        receipt_ref: hit.id,
        receipt_url: hit.fileUrl,
        receipt_source: 'external_app',
        receipt_matched_at: new Date().toISOString(),
      };
      if (!(charge as { driver_id: string | null }).driver_id) {
        const did = driverIdByName(hit.driver);
        if (did) update.driver_id = did;
      }
      const { error } = await db.from('card_charges').update(update).eq('id', charge.id);
      if (!error) matched++;
    }
  }

  const { count: missing } = await db
    .from('card_charges')
    .select('id', { count: 'exact', head: true })
    .eq('receipt_status', 'missing');

  return {
    configured: { plaid: plaidReady, receipts: receiptsConfigured(), quickbooks: qbConnected },
    pulled, qbPulled, matched, missing: missing || 0, qbError,
  };
}
