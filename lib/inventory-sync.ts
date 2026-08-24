// Shared inventory-level sync: pulls QtyOnHand (and QB ReorderPoint) for every
// active QuickBooks item and updates matching inventory_items (by SKU, then
// fully-qualified name). For notify-flagged items that newly drop to/below
// their reorder point, creates a bell notification to admins (which also
// pushes), de-duped via low_stock_notified_at.
//
// Used by the manual admin button (/api/quickbooks/sync-inventory) and the
// nightly cron (/api/cron/sync-inventory).

import { createAdminClient } from '@/lib/supabase-admin';
import { listAllItems } from '@/lib/quickbooks';

// QuickBooks names items as "Packaging:Product" (e.g. "GAL:SUPREME UHP DEXOS
// 0W-20", "EBOX:MAG 1 FULL SYNTHETIC DEXOS 0W-20"). The top-level parent before
// the first colon is the packaging/section the inventory page groups by, so
// derive it from the name when we don't already have one.
export function packagingFromQbName(name: string): string | null {
  const i = (name || '').indexOf(':');
  if (i <= 0) return null;
  const p = name.slice(0, i).trim();
  return p || null;
}

// Pull cost, retail, and stock FROM QuickBooks into inventory_items — QB is the
// source of truth for prices. Matches existing items by SKU then name, updates
// only the fields QB actually has (so a blank QB price never wipes the app's),
// and inserts any items we don't yet track. Returns counts.
export async function syncInventoryFromQuickBooks(): Promise<{ updated: number; imported: number; total: number }> {
  const items = await listAllItems();
  const admin = createAdminClient();

  const { data: inv } = await admin.from('inventory_items').select('id, sku, qb_name, packaging');
  type Existing = { id: string; sku: string | null; qb_name: string; packaging: string | null };
  const bySku = new Map<string, Existing>();
  const byName = new Map<string, Existing>();
  for (const r of (inv as Existing[]) || []) {
    if (r.sku) bySku.set(r.sku.trim().toLowerCase(), r);
    byName.set((r.qb_name || '').trim().toLowerCase(), r);
  }

  const now = new Date().toISOString();
  let updated = 0;
  const toInsert: Record<string, unknown>[] = [];

  for (const it of items) {
    const name = (it.FullyQualifiedName || it.Name || '').trim();
    if (!name) continue;
    const k1 = (it.Sku || '').trim().toLowerCase();
    const row = (k1 && bySku.get(k1)) || byName.get(name.toLowerCase());

    if (row) {
      // Update only what QB provides — don't wipe an app price QB lacks.
      // IMPORTANT: QuickBooks returns PurchaseCost/UnitPrice as 0 for items with
      // no cost/price set. Treat 0 as "not set" and DON'T overwrite the app's
      // maintained value with it — otherwise a nightly sync silently zeroes the
      // cost basis and commissions balloon (gross profit becomes the whole sale).
      const fields: Record<string, unknown> = { qb_qty_synced_at: now };
      if (it.PurchaseCost != null && Number(it.PurchaseCost) > 0) fields.cost = it.PurchaseCost;
      if (it.UnitPrice != null && Number(it.UnitPrice) > 0) fields.retail_price = it.UnitPrice;
      if (it.QtyOnHand != null) fields.qty_on_hand = it.QtyOnHand;
      // Keep the item name + packaging section in step with QuickBooks (the
      // source of truth). Re-categorizing an item there (e.g. moving it from the
      // 3/1 parent to 4/1) now flows through instead of sticking on the old
      // value. Matched by SKU, so a name/prefix change is picked up.
      if (name && name !== row.qb_name) fields.qb_name = name;
      const pkg = packagingFromQbName(name);
      if (pkg && pkg !== row.packaging) fields.packaging = pkg;
      await admin.from('inventory_items').update(fields).eq('id', row.id);
      updated++;
    } else {
      toInsert.push({
        qb_name: name,
        sku: it.Sku || null,
        packaging: packagingFromQbName(name),
        cost: it.PurchaseCost != null && Number(it.PurchaseCost) > 0 ? it.PurchaseCost : null,
        retail_price: it.UnitPrice != null && Number(it.UnitPrice) > 0 ? it.UnitPrice : null,
        qty_on_hand: it.QtyOnHand ?? null,
        qb_type: it.Type || null,
        qb_qty_synced_at: now,
        active: true,
      });
    }
  }
  if (toInsert.length) {
    await admin.from('inventory_items').upsert(toInsert, { onConflict: 'qb_name', ignoreDuplicates: true });
  }
  return { updated, imported: toInsert.length, total: items.length };
}

type InvRow = {
  id: string;
  sku: string | null;
  qb_name: string;
  reorder_point: number | null;
  reorder_notify: boolean;
  low_stock_notified_at: string | null;
};

// Import any QuickBooks items missing from inventory_items (insert-only, so it
// never clobbers cost/retail/packaging on items already managed in the app).
// Used by the "Sync items from QuickBooks" button so the bill line→item
// mapping dropdown has every product, fee, and tax item.
export async function importQbItems(): Promise<{ imported: number; total: number }> {
  const items = await listAllItems();
  const admin = createAdminClient();

  const rows = items
    .map((it) => {
      const qb_name = (it.FullyQualifiedName || it.Name || '').trim();
      return {
        qb_name,
        sku: it.Sku || null,
        packaging: packagingFromQbName(qb_name),
        cost: it.PurchaseCost != null && Number(it.PurchaseCost) > 0 ? it.PurchaseCost : null,
        retail_price: it.UnitPrice != null && Number(it.UnitPrice) > 0 ? it.UnitPrice : null,
        qty_on_hand: it.QtyOnHand ?? null,
        qb_type: it.Type || null,
        active: true,
      };
    })
    .filter((r) => r.qb_name);

  const { data: existing } = await admin.from('inventory_items').select('qb_name');
  const have = new Set(((existing as { qb_name: string }[]) || []).map((r) => r.qb_name.trim().toLowerCase()));
  const toInsert = rows.filter((r) => !have.has(r.qb_name.toLowerCase()));

  if (toInsert.length) {
    // ignoreDuplicates: a concurrent run or case-collision is skipped, not errored.
    await admin.from('inventory_items').upsert(toInsert, { onConflict: 'qb_name', ignoreDuplicates: true });
  }
  return { imported: toInsert.length, total: rows.length };
}

export async function syncInventoryLevels(): Promise<{ synced: number; newlyLow: number; recovered: number }> {
  const qbItems = await listAllItems();
  const admin = createAdminClient();

  const { data: inv } = await admin
    .from('inventory_items')
    .select('id, sku, qb_name, reorder_point, reorder_notify, low_stock_notified_at');
  const rows = (inv as InvRow[]) || [];

  const bySku = new Map<string, InvRow>();
  const byName = new Map<string, InvRow>();
  for (const r of rows) {
    if (r.sku) bySku.set(r.sku.trim().toLowerCase(), r);
    byName.set((r.qb_name || '').trim().toLowerCase(), r);
  }

  const now = new Date().toISOString();
  let synced = 0;
  const newlyLow: InvRow[] = [];
  const recovered: string[] = [];

  for (const it of qbItems) {
    if (it.QtyOnHand == null) continue; // non-inventory item
    const k1 = (it.Sku || '').trim().toLowerCase();
    const k2 = (it.FullyQualifiedName || it.Name || '').trim().toLowerCase();
    const row = (k1 && bySku.get(k1)) || byName.get(k2);
    if (!row) continue;

    const qty = it.QtyOnHand;
    const update: Record<string, unknown> = { qty_on_hand: qty, qb_qty_synced_at: now };
    const effectiveReorder =
      row.reorder_point != null ? row.reorder_point
      : (typeof it.ReorderPoint === 'number' ? it.ReorderPoint : null);
    if (row.reorder_point == null && typeof it.ReorderPoint === 'number') {
      update.reorder_point = it.ReorderPoint;
    }
    await admin.from('inventory_items').update(update).eq('id', row.id);
    synced++;

    const isLow = effectiveReorder != null && qty <= effectiveReorder;
    if (isLow && row.reorder_notify && !row.low_stock_notified_at) newlyLow.push(row);
    if (!isLow && row.low_stock_notified_at) recovered.push(row.id);
  }

  if (recovered.length) {
    await admin.from('inventory_items').update({ low_stock_notified_at: null }).in('id', recovered);
  }
  if (newlyLow.length) {
    const ids = newlyLow.map((r) => r.id);
    await admin.from('inventory_items').update({ low_stock_notified_at: now }).in('id', ids);

    const { data: lowItems } = await admin
      .from('inventory_items')
      .select('description, qb_name, qty_on_hand')
      .in('id', ids);
    const lines = ((lowItems as { description: string | null; qb_name: string; qty_on_hand: number | null }[]) || [])
      .map((li) => `${li.description || li.qb_name} (${li.qty_on_hand ?? 0} left)`);
    const body = lines.slice(0, 8).join(', ') + (lines.length > 8 ? ` +${lines.length - 8} more` : '');

    const { data: admins } = await admin.from('profiles').select('id').in('role', ['admin', 'master_admin']);
    const notes = ((admins as { id: string }[]) || []).map((a) => ({
      recipient_id: a.id,
      kind: 'reorder',
      title: `Low stock — ${newlyLow.length} item${newlyLow.length > 1 ? 's' : ''} need reorder`,
      body,
      link: '/admin/inventory',
    }));
    if (notes.length) await admin.from('notifications').insert(notes);
  }

  return { synced, newlyLow: newlyLow.length, recovered: recovered.length };
}
