// GET /api/admin/cost-history — admin-only.
//
// Product purchase costs by date / product / vendor, pulled live from
// QuickBooks Bills and Purchases (expenses) since 2026-01-01. Every item line on
// a bill/expense becomes one row, so it stays current as bills get entered.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { qbFetch } from '@/lib/quickbooks';
import { GASOLINE_RE } from '@/lib/fuel-detect';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SINCE = '2026-01-01';

type QBExpenseLine = {
  DetailType?: string;
  Amount?: number;
  ItemBasedExpenseLineDetail?: {
    ItemRef?: { value?: string; name?: string };
    Qty?: number;
    UnitPrice?: number;
  };
};
type QBTxn = {
  TxnDate?: string;
  VendorRef?: { value?: string; name?: string };
  EntityRef?: { value?: string; name?: string; type?: string };
  Line?: QBExpenseLine[];
};

export type CostRow = {
  date: string | null;
  product: string;
  cost: number;
  qty: number | null;
  vendor: string;
};

async function fetchAll(entity: 'Bill' | 'Purchase'): Promise<QBTxn[]> {
  const out: QBTxn[] = [];
  let start = 1;
  const page = 100;
  while (true) {
    const q = `select * from ${entity} where TxnDate >= '${SINCE}' orderby TxnDate desc startposition ${start} maxresults ${page}`;
    const res = await qbFetch<{ QueryResponse: Record<string, QBTxn[] | undefined> }>(
      `/query?query=${encodeURIComponent(q)}`,
    );
    const batch = (res.QueryResponse[entity] as QBTxn[] | undefined) || [];
    out.push(...batch);
    if (batch.length < page) break;
    start += page;
  }
  return out;
}

function bare(s: string): string {
  const t = (s || '').toLowerCase();
  const i = t.lastIndexOf(':');
  return (i >= 0 ? t.slice(i + 1) : t).trim();
}
// Fuel excise / LUST / hazard / cleanup / spill fee lines — folded into the fuel
// line's cost rather than listed on their own.
function isFuelTax(name?: string): boolean {
  return /\b(tax|excise|lust|hazard|envir|cleanup|fee|spill)\b/.test(bare(name || ''));
}
// Clear/dyed diesel + gasoline product lines.
function isFuelProduct(name?: string): boolean {
  if (isFuelTax(name)) return false;
  const b = bare(name || '');
  if (/dyed/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  if (/clear/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  return GASOLINE_RE.test(b);
}

// Vendor id → display name. QuickBooks often returns only the ref id (no name)
// on bill/purchase lines, so resolve names from the vendor list.
async function fetchVendorNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 1;
  const page = 200;
  while (true) {
    const q = `select Id, DisplayName from Vendor startposition ${start} maxresults ${page}`;
    const res = await qbFetch<{ QueryResponse: { Vendor?: { Id: string; DisplayName?: string }[] } }>(
      `/query?query=${encodeURIComponent(q)}`,
    );
    const batch = res.QueryResponse.Vendor || [];
    for (const v of batch) if (v.DisplayName) map.set(v.Id, v.DisplayName);
    if (batch.length < page) break;
    start += page;
  }
  return map;
}

export async function GET() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const [bills, purchases, vendorNames] = await Promise.all([
      fetchAll('Bill'),
      fetchAll('Purchase'),
      fetchVendorNames(),
    ]);
    const rows: CostRow[] = [];
    const add = (txn: QBTxn) => {
      const ref = txn.VendorRef || (txn.EntityRef?.type === 'Vendor' ? txn.EntityRef : undefined);
      const vendor = ref?.name || (ref?.value ? vendorNames.get(ref.value) : '') || '—';
      const itemLines = (txn.Line || []).filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail');
      // Sum the fuel taxes/fees and split them across the fuel product lines (by
      // amount) so each fuel row shows its all-in cost. Tax lines are never
      // listed on their own.
      const taxTotal = itemLines
        .filter((l) => isFuelTax(l.ItemBasedExpenseLineDetail?.ItemRef?.name))
        .reduce((s, l) => s + Number(l.Amount ?? 0), 0);
      const productLines = itemLines.filter((l) => !isFuelTax(l.ItemBasedExpenseLineDetail?.ItemRef?.name));
      const fuelAmtTotal = productLines
        .filter((l) => isFuelProduct(l.ItemBasedExpenseLineDetail?.ItemRef?.name))
        .reduce((s, l) => s + Number(l.Amount ?? 0), 0);

      for (const line of productLines) {
        const d = line.ItemBasedExpenseLineDetail!;
        const qty = d.Qty != null ? Number(d.Qty) : null;
        let amt = Number(line.Amount ?? 0);
        const fuel = isFuelProduct(d.ItemRef?.name);
        if (fuel && taxTotal > 0 && fuelAmtTotal > 0) {
          amt += taxTotal * (amt / fuelAmtTotal); // fold in the fuel taxes
        }
        const unit = fuel
          ? qty && qty > 0 ? amt / qty : amt
          : d.UnitPrice != null ? Number(d.UnitPrice) : qty && qty > 0 ? amt / qty : amt;
        const cost = Math.round(unit * 100) / 100;
        // Skip $0 lines — those aren't purchases (e.g. fuel pulled at no cost to
        // supply our own trucks), so they shouldn't count as a product cost.
        if (cost <= 0) continue;
        rows.push({
          date: txn.TxnDate ?? null,
          product: d.ItemRef?.name || 'Item',
          cost,
          qty,
          vendor,
        });
      }
    };
    for (const b of bills) add(b);
    for (const p of purchases) add(p);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
