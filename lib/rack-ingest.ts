// ============================================================================
// Rack-price email ingestion — Microsoft 365 mailbox → rack_prices.
// ============================================================================
// The DTN/Sinclair rack-price sheet arrives as a plain-text (or HTML) email in
// the same mailbox the vendor bills use. This pulls unread messages, runs them
// through the same parser the manual paste box uses, and upserts the rows into
// rack_prices — so fuel orders price themselves without anyone pasting the
// email. A message is only marked read once we actually found price rows in it,
// so unrelated mail is left untouched.
//
// Optional env var RACK_PRICE_FROM scopes the scan to one sender address (the
// DTN/Sinclair address). Strongly recommended when reading a shared Inbox so we
// never read the body of unrelated personal mail. If unset, we fall back to
// content-detection: only messages that parse into rack rows are acted on.

import { createAdminClient } from '@/lib/supabase-admin';
import { listMessagesWithBody } from '@/lib/ms-graph';
import { parseRackPriceEmail } from '@/lib/fuel-prices';

export type RackIngestResult = {
  scanned: number;
  emailsWithPrices: number;
  rowsSaved: number;
  errors: string[];
};

export async function ingestRackPricesFromEmail(limit = 25): Promise<RackIngestResult> {
  const supabase = createAdminClient();
  const result: RackIngestResult = { scanned: 0, emailsWithPrices: 0, rowsSaved: 0, errors: [] };

  const fromAddress = process.env.RACK_PRICE_FROM?.trim() || undefined;
  const messages = await listMessagesWithBody(fromAddress, limit);
  result.scanned = messages.length;

  for (const msg of messages) {
    try {
      const parsed = parseRackPriceEmail(msg.text);
      if (parsed.length === 0) {
        // Not a rack-price email (or unparseable) — leave it untouched/unread.
        continue;
      }
      const rows = parsed.map((r) => ({
        location: r.location,
        product: r.product,
        eff_date: r.effDate,
        price: r.price,
        change: r.change,
        source: 'dtn-sinclair',
        received_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from('rack_prices')
        .upsert(rows, { onConflict: 'location,product,eff_date' });
      if (error) throw new Error(error.message);

      result.emailsWithPrices++;
      result.rowsSaved += rows.length;
      // No mark-read: re-parsing is idempotent (rack prices upsert), and this
      // is a personal inbox we don't want to mutate.
    } catch (e) {
      result.errors.push(`${msg.id}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  return result;
}
