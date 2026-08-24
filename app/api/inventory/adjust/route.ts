// POST /api/inventory/adjust — drivers + admins set corrected on-hand counts.
//
// Body: { adjustments: [{ item_id, new_qty }] }
// Updates inventory_items.qty_on_hand for each (service-role), then pushes the
// new on-hand to QuickBooks. App levels always update; the QB push result
// (updated / skipped / errors) is returned so the UI can show what synced.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { pushItemQuantities } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!me || !['driver', 'mechanic', 'admin', 'master_admin'].includes(me.role)) {
    return NextResponse.json({ ok: false, error: 'drivers and admins only' }, { status: 403 });
  }

  let body: { adjustments?: { item_id?: string; new_qty?: number }[] };
  try { body = await req.json(); } catch { body = {}; }
  const rows = (body.adjustments || []).filter(
    (a) => a.item_id && a.new_qty != null && Number.isFinite(Number(a.new_qty)) && Number(a.new_qty) >= 0,
  );
  if (rows.length === 0) return NextResponse.json({ ok: false, error: 'no valid adjustments' }, { status: 400 });

  const db = createAdminClient();

  // Load the items being adjusted (id → qb_name) and apply the new counts.
  const ids = rows.map((r) => r.item_id as string);
  const { data: items } = await db
    .from('inventory_items')
    .select('id, qb_name, description, packaging, qty_on_hand')
    .in('id', ids);
  type Row = { id: string; qb_name: string; description: string | null; packaging: string | null; qty_on_hand: number | null };
  const byId = new Map(((items as Row[]) || []).map((i) => [i.id, i]));

  const now = new Date().toISOString();
  let appUpdated = 0;
  const qbUpdates: { qbName: string; qty: number }[] = [];
  const changes: { name: string; packaging: string | null; from: number; to: number }[] = [];
  for (const r of rows) {
    const it = byId.get(r.item_id as string);
    if (!it) continue;
    const qty = Math.round(Number(r.new_qty));
    const from = it.qty_on_hand ?? 0;
    const { error } = await db
      .from('inventory_items')
      .update({ qty_on_hand: qty, qb_qty_synced_at: now })
      .eq('id', it.id);
    if (!error) {
      appUpdated++;
      if (it.qb_name) qbUpdates.push({ qbName: it.qb_name, qty });
      if (qty !== from) changes.push({ name: it.description || it.qb_name, packaging: it.packaging, from, to: qty });
    }
  }

  // Notify all admins with a report of what changed, who changed it, and when.
  if (changes.length > 0) {
    const { data: actor } = await db.from('profiles').select('full_name, email').eq('id', user.id).single();
    const actorName = (actor?.full_name || actor?.email || 'Someone') as string;
    const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const lines = changes.map((c) => {
      const diff = c.to - c.from;
      const unit = c.packaging ? ` ${c.packaging}` : '';
      const dir = diff < 0 ? `−${Math.abs(diff)}` : `+${diff}`;
      return `• ${c.name}: ${c.from} → ${c.to} (${dir}${unit})`;
    });
    const body = `Inventory Adjustments — by ${actorName}, ${when}\n\n${lines.join('\n')}`;
    const { data: admins } = await db.from('profiles').select('id').in('role', ['admin', 'master_admin']);
    const recipients = ((admins as { id: string }[]) || []).map((a) => a.id);
    if (recipients.length > 0) {
      await db.from('notifications').insert(recipients.map((rid) => ({
        recipient_id: rid,
        kind: 'inventory_adjustment',
        title: `Inventory adjusted by ${actorName} (${changes.length} item${changes.length === 1 ? '' : 's'})`,
        body,
        link: '/admin/inventory',
      })));
    }
  }

  // Push the new counts to QuickBooks (best-effort — app levels already saved).
  let qb: { updated: number; skipped: { qbName: string; reason: string }[]; errors: { qbName: string; error: string }[] } | null = null;
  let qbError: string | null = null;
  if (qbUpdates.length > 0) {
    try { qb = await pushItemQuantities(qbUpdates); }
    catch (e) { qbError = e instanceof Error ? e.message : 'QuickBooks push failed'; }
  }

  return NextResponse.json({ ok: true, app_updated: appUpdated, qb, qb_error: qbError });
}
