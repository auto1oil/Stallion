// Fuel tax rates — admin-only. The per-gallon fuel taxes are stored in the app
// (app_settings 'fuel_tax_rates') as the source of truth, since they never
// change but QuickBooks sometimes zeroes them.
//
//   GET                        → { rates, products, stored }
//   POST { rates }             → save the edited rates
//   POST { action: 'sync' }    → pull current rates from QuickBooks and save
//
// `products` lists the QB tax-item names that make up each fuel product, so the
// editor can render an input per tax. `stored` is false until rates are saved.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { FUEL_TAX_ITEM_NAMES, findItemsByNames } from '@/lib/quickbooks';
import { FUEL_TAX_RATES_KEY, getStoredFuelTaxRates } from '@/lib/fuel-tax-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 }) };
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return { error: NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 }) };
  }
  return { error: null };
}

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = createAdminClient();
  const stored = await getStoredFuelTaxRates(db);
  return NextResponse.json({
    ok: true,
    rates: stored || {},
    products: FUEL_TAX_ITEM_NAMES,
    stored: stored != null,
  });
}

export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = createAdminClient();
  const body = await req.json().catch(() => ({}));

  let rates: Record<string, number> = {};

  if (body.action === 'sync') {
    // Pull the current per-gallon rate off each QB tax item.
    const allNames = Array.from(new Set(Object.values(FUEL_TAX_ITEM_NAMES).flat()));
    let items: Record<string, { UnitPrice?: number }> = {};
    try {
      items = await findItemsByNames(allNames);
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks read failed' }, { status: 502 });
    }
    for (const n of allNames) rates[n] = Number(items[n]?.UnitPrice ?? 0);
  } else if (body.rates && typeof body.rates === 'object') {
    const allNames = new Set(Object.values(FUEL_TAX_ITEM_NAMES).flat());
    for (const [k, v] of Object.entries(body.rates as Record<string, unknown>)) {
      if (allNames.has(k)) rates[k] = Number(v) || 0;
    }
  } else {
    return NextResponse.json({ ok: false, error: 'rates or action required' }, { status: 400 });
  }

  const { error: upErr } = await db
    .from('app_settings')
    .upsert({ key: FUEL_TAX_RATES_KEY, value: JSON.stringify(rates) }, { onConflict: 'key' });
  if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, rates });
}
