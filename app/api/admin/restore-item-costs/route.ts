// POST /api/admin/restore-item-costs — admin-only, one-shot repair.
//
// Refills inventory_items.cost for active items whose cost was lost (null or 0)
// using the most recent per-unit cost seen on QuickBooks Bills/Purchases since
// 2026-01-01. Fuel products are skipped (their cost basis is the daily rack
// price, not a static item cost). Never lowers/overwrites an item that already
// has a positive cost.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { qbFetch } from '@/lib/quickbooks';
import { GASOLINE_RE } from '@/lib/fuel-detect';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SINCE = '2026-01-01';

type QBExpenseLine = {
  DetailType?: string;
  Amount?: number;
  ItemBasedExpenseLineDetail?: { ItemRef?: { name?: string }; Qty?: number; UnitPrice?: number };
};
type QBTxn = { TxnDate?: string; Line?: QBExpenseLine[] };

function bare(s: string): string {
  const t = (s || '').toLowerCase();
  const i = t.lastIndexOf(':');
  return (i >= 0 ? t.slice(i + 1) : t).trim();
}
function isFuelTax(name?: string): boolean {
  return /\b(tax|excise|lust|hazard|envir|cleanup|fee|spill)\b/.test(bare(name || ''));
}
function isFuelProduct(name?: string): boolean {
  if (isFuelTax(name)) return false;
  const b = bare(name || '');
  if (/dyed/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  if (/clear/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  return GASOLINE_RE.test(b);
}

async function fetchAll(entity: 'Bill' | 'Purchase'): Promise<QBTxn[]> {
  const out: QBTxn[] = [];
  let start = 1;
  const page = 100;
  while (true) {
    const q = `select * from ${entity} where TxnDate >= '${SINCE}' orderby TxnDate desc startposition ${start} maxresults ${page}`;
    const res = await qbFetch<{ QueryResponse: Record<string, QBTxn[] | undefined> }>(`/query?query=${encodeURIComponent(q)}`);
    const batch = (res.QueryResponse[entity] as QBTxn[] | undefined) || [];
    out.push(...batch);
    if (batch.length < page) break;
    start += page;
  }
  return out;
}

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const [bills, purchases] = await Promise.all([fetchAll('Bill'), fetchAll('Purchase')]);

    // Newest per-unit cost per item name (full + bare). Txns are fetched newest
    // first, so the first cost we see for a name is the most recent.
    const costByName = new Map<string, number>();
    const consider = (txn: QBTxn) => {
      for (const line of txn.Line || []) {
        if (line.DetailType !== 'ItemBasedExpenseLineDetail') continue;
        const d = line.ItemBasedExpenseLineDetail!;
        const name = d.ItemRef?.name || '';
        if (!name || isFuelTax(name) || isFuelProduct(name)) continue; // fuel = rack-priced
        const qty = d.Qty != null ? Number(d.Qty) : null;
        const amt = Number(line.Amount ?? 0);
        const unit = d.UnitPrice != null && Number(d.UnitPrice) > 0
          ? Number(d.UnitPrice)
          : qty && qty > 0 ? amt / qty : amt;
        const cost = Math.round(unit * 100) / 100;
        if (!(cost > 0)) continue;
        for (const k of [name.trim().toLowerCase(), bare(name)]) {
          if (k && !costByName.has(k)) costByName.set(k, cost);
        }
      }
    };
    for (const b of bills) consider(b);
    for (const p of purchases) consider(p);

    const db = createAdminClient();
    const { data: invRows } = await db
      .from('inventory_items')
      .select('id, qb_name, cost')
      .eq('active', true);

    const updated: { qb_name: string; cost: number }[] = [];
    const unmatched: string[] = [];
    for (const r of (invRows as { id: string; qb_name: string | null; cost: number | null }[]) || []) {
      if (r.cost != null && Number(r.cost) > 0) continue; // already costed
      const nm = (r.qb_name || '').trim().toLowerCase();
      const cost = costByName.get(nm) ?? costByName.get(bare(r.qb_name || ''));
      if (cost == null) { if (r.qb_name) unmatched.push(r.qb_name); continue; }
      await db.from('inventory_items').update({ cost }).eq('id', r.id);
      updated.push({ qb_name: r.qb_name || '', cost });
    }

    return NextResponse.json({ ok: true, updated_count: updated.length, updated, unmatched });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
