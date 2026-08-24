// POST /api/quickbooks/push-prices — admin-only bulk price push.
//
// Takes the cost/retail we hold in inventory_items and writes them up to
// QuickBooks (PurchaseCost / UnitPrice) for every matching item, batched. This
// turns a 300-item repricing into one click. Only changed values are sent; the
// nightly QB→app sync then sees QB already matches, so nothing is clobbered.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { pushItemPrices, type ItemPriceUpdate } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const { data: rows, error } = await supabase
      .from('inventory_items')
      .select('qb_name, cost, retail_price');
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const updates: ItemPriceUpdate[] = (rows || [])
      .filter((r) => r.qb_name && (r.cost != null || r.retail_price != null))
      .map((r) => ({ qbName: r.qb_name as string, cost: r.cost, retail: r.retail_price }));

    if (updates.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, skipped: [], errors: [], message: 'No priced items to push.' });
    }

    const result = await pushItemPrices(updates);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
