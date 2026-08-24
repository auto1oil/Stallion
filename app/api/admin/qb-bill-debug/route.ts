// GET /api/admin/qb-bill-debug?vendor=petro — admin-only diagnostic.
//
// Dumps a vendor's recent Bills + Purchases line by line — BOTH item-based and
// account-based lines — so we can see why a vendor's costs aren't showing in the
// price comparison (which only reads item-based lines). Shows the raw line
// name/description, qty, unit price and amount.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { qbFetch } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SINCE = '2026-01-01';

type QBLine = {
  DetailType?: string;
  Amount?: number;
  Description?: string;
  ItemBasedExpenseLineDetail?: { ItemRef?: { name?: string }; Qty?: number; UnitPrice?: number };
  AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } };
};
type QBTxn = {
  TxnDate?: string;
  DocNumber?: string;
  VendorRef?: { value?: string; name?: string };
  EntityRef?: { value?: string; name?: string; type?: string };
  Line?: QBLine[];
};

async function fetchAll(entity: 'Bill' | 'Purchase'): Promise<QBTxn[]> {
  const out: QBTxn[] = [];
  let start = 1;
  const page = 100;
  for (;;) {
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

async function vendorNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 1;
  const page = 200;
  for (;;) {
    const res = await qbFetch<{ QueryResponse: { Vendor?: { Id: string; DisplayName?: string }[] } }>(
      `/query?query=${encodeURIComponent(`select Id, DisplayName from Vendor startposition ${start} maxresults ${page}`)}`,
    );
    const batch = res.QueryResponse.Vendor || [];
    for (const v of batch) if (v.DisplayName) map.set(v.Id, v.DisplayName);
    if (batch.length < page) break;
    start += page;
  }
  return map;
}

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const needle = (req.nextUrl.searchParams.get('vendor') || '').toLowerCase().trim();
    const [bills, purchases, names] = await Promise.all([fetchAll('Bill'), fetchAll('Purchase'), vendorNames()]);

    const out = [...bills.map((t) => ({ t, kind: 'Bill' })), ...purchases.map((t) => ({ t, kind: 'Purchase' }))]
      .map(({ t, kind }) => {
        const ref = t.VendorRef || (t.EntityRef?.type === 'Vendor' ? t.EntityRef : undefined);
        const vendor = ref?.name || (ref?.value ? names.get(ref.value) : '') || '—';
        return { t, kind, vendor };
      })
      .filter(({ vendor }) => !needle || vendor.toLowerCase().includes(needle))
      .map(({ t, kind, vendor }) => ({
        kind,
        vendor,
        date: t.TxnDate ?? null,
        docNumber: t.DocNumber ?? null,
        lines: (t.Line || [])
          .filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail' || l.DetailType === 'AccountBasedExpenseLineDetail')
          .map((l) => {
            const item = l.ItemBasedExpenseLineDetail;
            const acct = l.AccountBasedExpenseLineDetail;
            return {
              type: l.DetailType === 'ItemBasedExpenseLineDetail' ? 'item' : 'account',
              name: item?.ItemRef?.name || acct?.AccountRef?.name || l.Description || '(no name)',
              description: l.Description ?? null,
              qty: item?.Qty ?? null,
              unitPrice: item?.UnitPrice ?? null,
              amount: l.Amount ?? null,
            };
          }),
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return NextResponse.json({ ok: true, vendorFilter: needle || '(all)', count: out.length, transactions: out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
