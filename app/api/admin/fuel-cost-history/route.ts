// GET /api/admin/fuel-cost-history — admin-only fuel cost-per-gallon history.
//
// For each fuel product (Clear Fuel, Dyed Fuel, 85-Octane, 91-Octane) we track
// the all-in cost per gallon over time: the rack price on that effective date
// (from rack_prices, via the product → rack location/product mapping) PLUS the
// sum of the fuel taxes that ride along with that product (the per-gallon rates
// live on the QuickBooks tax items — see FUEL_TAX_ITEM_NAMES).
//
// Rack prices change date to date; the tax rates are essentially fixed, so we
// apply the current QB tax rate to every historical row (the best we can do
// without storing dated tax snapshots). Returns rows newest-first.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { FUEL_TAX_ITEM_NAMES, findItemsByNames } from '@/lib/quickbooks';
import { getStoredFuelTaxRates, taxByProductFromRates } from '@/lib/fuel-tax-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FUEL_PRODUCTS = ['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane'] as const;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  try {
    const db = createAdminClient();

    // 1. Product → rack (location, product) mapping.
    const { data: mapRows } = await db
      .from('fuel_price_mappings')
      .select('app_product, rack_location, rack_product');
    const mapping: Record<string, { location: string; product: string }> = {};
    for (const m of (mapRows as { app_product: string; rack_location: string; rack_product: string }[]) || []) {
      mapping[m.app_product] = { location: m.rack_location, product: m.rack_product };
    }

    // 2. Per-product tax sum. The app-side rates (app_settings) are the source
    //    of truth since the taxes never change; only fall back to live QB rates
    //    if nothing has been saved in the app yet.
    let rates = await getStoredFuelTaxRates(db);
    if (!rates) {
      const allTaxNames = Array.from(new Set(Object.values(FUEL_TAX_ITEM_NAMES).flat()));
      try {
        const taxItems = await findItemsByNames(allTaxNames);
        rates = {};
        for (const n of allTaxNames) rates[n] = Number(taxItems[n]?.UnitPrice ?? 0);
      } catch {
        rates = {};
      }
    }
    const { taxByProduct, taxBreakdown } = taxByProductFromRates(rates);

    // 3. Rack prices for every mapped (location, product). Group by eff_date.
    const locs = Array.from(new Set(Object.values(mapping).map((m) => m.location).filter(Boolean)));
    const prods = Array.from(new Set(Object.values(mapping).map((m) => m.product).filter(Boolean)));

    let rackRows: { location: string; product: string; eff_date: string | null; price: number }[] = [];
    if (locs.length && prods.length) {
      const { data } = await db
        .from('rack_prices')
        .select('location, product, eff_date, price')
        .in('location', locs)
        .in('product', prods)
        .not('eff_date', 'is', null)
        .order('eff_date', { ascending: false })
        .limit(2000);
      rackRows = (data as typeof rackRows) || [];
    }

    // Index newest rack price per (location|product|eff_date).
    const rackByKey = new Map<string, number>();
    for (const r of rackRows) {
      const key = `${r.location}|||${r.product}|||${r.eff_date}`;
      if (!rackByKey.has(key)) rackByKey.set(key, Number(r.price)); // first wins (desc)
    }

    // 4. Build a row per distinct eff_date; fill each product's cell.
    const dates = Array.from(new Set(rackRows.map((r) => r.eff_date).filter((d): d is string => !!d)))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first

    const products = FUEL_PRODUCTS.filter((p) => mapping[p]?.location && mapping[p]?.product);

    const rows = dates.map((date) => {
      const prices: Record<string, { rack: number; tax: number; total: number } | null> = {};
      for (const p of products) {
        const m = mapping[p];
        const rack = rackByKey.get(`${m.location}|||${m.product}|||${date}`);
        if (rack == null) { prices[p] = null; continue; }
        const tax = taxByProduct[p] || 0;
        prices[p] = { rack, tax, total: rack + tax };
      }
      return { date, prices };
    }).filter((row) => products.some((p) => row.prices[p] != null));

    return NextResponse.json({
      ok: true,
      products,
      taxByProduct,
      taxBreakdown,
      rows,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
