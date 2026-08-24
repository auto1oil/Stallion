// ============================================================================
// Vendor-bill email ingestion — Microsoft Graph mailbox → review queue.
// ============================================================================
// Pulls unread bill emails from the configured mailbox, saves the first
// PDF/image attachment to the vendor-bills bucket, runs AI extraction to
// prefill the fields, and creates a 'pending' vendor_bills row. Each message is
// then marked read so it isn't ingested again (with source_message_id as a
// second guard). Nothing posts to QuickBooks here — bills land in the queue for
// an admin to confirm and push. Reused by the nightly cron and the manual
// "Check email now" button.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase-admin';
import { listBillMessages, getMessageAttachments } from '@/lib/ms-graph';
import { parseBillDocument } from '@/lib/bill-parse';
import { applyLineMappings } from '@/lib/bill-map';

export type IngestResult = {
  scanned: number;
  matched: number;     // messages from an approved vendor sender
  duplicate: number;   // approved, but already filed
  created: number;
  skipped: number;
  errors: string[];
  senders?: string[];  // a few sample From addresses scanned, for diagnosis
};

// Sender allowlist. Sources, merged: the bill_vendors table (master admins
// maintain it on the Bills page) plus an optional BILLS_FROM env var. Each
// entry is a vendor email address or domain (e.g. "loves.com",
// "billing@bradhall.com"). Only emails from a matching sender become draft
// bills — keeps a shared/personal inbox from filing every random attachment.
// If nothing is configured anywhere, we fall back to open (accept any sender).
async function allowedSenders(
  supabase: SupabaseClient,
): Promise<string[]> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^@/, '');
  const fromEnv = (process.env.BILLS_FROM || '').split(',').map(norm).filter(Boolean);
  const { data } = await supabase
    .from('bill_vendors')
    .select('sender')
    .eq('active', true)
    .not('sender', 'is', null);
  const fromDb = (data || []).map((r) => norm((r as { sender: string }).sender)).filter(Boolean);
  return Array.from(new Set([...fromEnv, ...fromDb]));
}

function senderAllowed(from: string | null, allow: string[]): boolean {
  if (allow.length === 0) return true; // no allowlist configured → open
  if (!from) return false;
  const f = from.toLowerCase();
  const domain = f.split('@')[1] || '';
  return allow.some((a) => f === a || domain === a || domain.endsWith('.' + a) || f.endsWith('@' + a));
}

// Pass an admin's session client (db) for user-triggered runs — the service-
// role role isn't granted on vendor_bills, so the admin's RLS access is what
// actually lets the insert through. Cron runs pass nothing (service role).
export async function ingestBillsFromEmail(db?: SupabaseClient, limit = 40): Promise<IngestResult> {
  const supabase = db ?? createAdminClient();
  const result: IngestResult = { scanned: 0, matched: 0, duplicate: 0, created: 0, skipped: 0, errors: [] };
  const allow = await allowedSenders(supabase);

  // Only ingest emails from the last couple of weeks — old invoices (already
  // handled / in QuickBooks) shouldn't be re-pulled. The daily check only needs
  // a short recent window; configurable via BILLS_LOOKBACK_DAYS.
  const lookbackDays = Number(process.env.BILLS_LOOKBACK_DAYS) || 14;
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  const all = await listBillMessages(limit);
  const messages = all.filter((m) => !m.receivedDateTime || m.receivedDateTime >= cutoff);
  result.scanned = messages.length;
  // Sample of the senders we saw, to diagnose allowlist mismatches.
  result.senders = Array.from(new Set(messages.map((m) => m.from || '(none)'))).slice(0, 12);

  for (const msg of messages) {
    try {
      // Outside the vendor allowlist → not a bill. Leave it untouched.
      if (!senderAllowed(msg.from, allow)) { result.skipped++; continue; }
      result.matched++;

      // Already filed this message → skip (dedup by message id, so reading the
      // email in the mailbox never causes a re-ingest or a miss).
      const { data: existing } = await supabase
        .from('vendor_bills')
        .select('id')
        .eq('source_message_id', msg.id)
        .maybeSingle();
      if (existing) { result.skipped++; result.duplicate++; continue; }

      const attachments = await getMessageAttachments(msg.id);
      if (attachments.length === 0) { result.skipped++; continue; }
      const primary = attachments[0];

      // Save the original file to the private bucket.
      const safeName = primary.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${new Date().getFullYear()}/${crypto.randomUUID()}-${safeName}`;
      const bytes = Buffer.from(primary.contentBytes, 'base64');
      const up = await supabase.storage.from('vendor-bills').upload(path, bytes, {
        contentType: primary.contentType,
        upsert: false,
      });
      if (up.error) throw new Error(`upload failed: ${up.error.message}`);

      // AI extraction is best-effort — a parse failure still files the bill so
      // the admin can fill it in by hand from the attached file.
      let parsed = null as Awaited<ReturnType<typeof parseBillDocument>> | null;
      let parseStatus = 'failed';
      try {
        parsed = await parseBillDocument(primary.contentBytes, primary.contentType);
        parseStatus = 'ok';
      } catch (e) {
        result.errors.push(`parse ${msg.id}: ${e instanceof Error ? e.message : 'failed'}`);
      }

      // Auto-map each line to an inventory item from this vendor's learned
      // mappings, so a returning vendor's bill arrives review-ready.
      const lines = await applyLineMappings(supabase, parsed?.vendor_name ?? null, parsed?.line_items ?? []);

      const { error: insErr } = await supabase.from('vendor_bills').insert({
        source: 'email',
        status: 'pending',
        source_message_id: msg.id,
        source_email_from: msg.from,
        source_email_subject: msg.subject,
        attachment_path: up.data.path,
        parsed: parsed as unknown,
        parse_status: parseStatus,
        vendor_name: parsed?.vendor_name ?? null,
        invoice_number: parsed?.invoice_number ?? null,
        bill_date: parsed?.bill_date ?? null,
        due_date: parsed?.due_date ?? null,
        total_amount: parsed?.total_amount ?? null,
        memo: parsed?.memo ?? null,
        line_items: lines,
      });
      if (insErr) throw new Error(`insert failed: ${insErr.message}`);

      result.created++;
    } catch (e) {
      result.errors.push(`${msg.id}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  return result;
}
