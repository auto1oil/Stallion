// ============================================================================
// Per-vendor bill-line → inventory-item mapping (learn-as-you-go).
// ============================================================================
// Vendor bills post to QuickBooks as item-based lines (so purchases count
// toward inventory + COGS). Each vendor words the same product differently, so
// we remember, per vendor, which inventory item a given line description maps
// to. The first time a line is seen an admin assigns the item at review; we
// store it here and every later bill from that vendor auto-maps. Tax lines are
// just pass-through items, so they use the same map.

import type { SupabaseClient } from '@supabase/supabase-js';

export type BillLine = {
  description: string;
  qty?: number | null;
  unit_cost?: number | null;
  amount: number;
  qb_item_name?: string | null;   // mapped inventory_items.qb_name
};

// Normalize a vendor name / line description to a stable lookup key: lowercase,
// collapse anything non-alphanumeric to single spaces, trim.
export function vendorKey(vendorName: string | null | undefined): string {
  return (vendorName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function lineKey(description: string | null | undefined): string {
  return (description || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Fill qb_item_name on any unmapped line from this vendor's learned mappings.
export async function applyLineMappings(
  db: SupabaseClient,
  vendorName: string | null,
  lines: BillLine[],
): Promise<BillLine[]> {
  const vk = vendorKey(vendorName);
  if (!vk || lines.length === 0) return lines;
  const { data } = await db
    .from('bill_line_map')
    .select('match_text, qb_item_name')
    .eq('vendor_key', vk);
  const map = new Map<string, string>(
    (data || []).map((r) => [(r as { match_text: string }).match_text, (r as { qb_item_name: string }).qb_item_name]),
  );
  return lines.map((l) => ({
    ...l,
    qb_item_name: l.qb_item_name || map.get(lineKey(l.description)) || null,
  }));
}

// Remember "this vendor's line wording → this item" for next time.
export async function learnMapping(
  db: SupabaseClient,
  vendorName: string | null,
  description: string | null,
  qbItemName: string | null,
): Promise<void> {
  const vk = vendorKey(vendorName);
  const mt = lineKey(description);
  if (!vk || !mt || !qbItemName) return;
  await db
    .from('bill_line_map')
    .upsert({ vendor_key: vk, match_text: mt, qb_item_name: qbItemName }, { onConflict: 'vendor_key,match_text' });
}
