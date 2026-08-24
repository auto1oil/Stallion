// GET /api/fuel-prices/tax-totals — per-gallon fuel tax total for each product,
// readable by any signed-in staff member (the rates live in app_settings, which
// is admin-only RLS, so we read them server-side here). Used by the "Today's
// Fuel Prices" widget to show the with-tax price alongside the rack+markup price.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { getStoredFuelTaxRates, taxByProductFromRates } from '@/lib/fuel-tax-rates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const db = createAdminClient();
  const rates = await getStoredFuelTaxRates(db);
  const { taxByProduct } = taxByProductFromRates(rates || {});
  return NextResponse.json({ ok: true, taxByProduct });
}
