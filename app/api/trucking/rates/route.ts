// GET /api/trucking/rates — staff-facing read for the driver create form:
// the active lanes + the current fuel-surcharge % (from settings, which drivers
// can't read directly because app_settings is admin-only).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { getTruckingSettings } from '@/lib/trucking';
import { listSalesTerms } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF = ['driver', 'mechanic', 'salesman', 'admin', 'master_admin'];

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !STAFF.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  const db = createAdminClient();
  const [{ data: lanes }, { data: commodities }, { data: customers }, settings, terms] = await Promise.all([
    db.from('trucking_lanes').select('id, origin, destination, rate_per_gallon').eq('active', true).order('sort_order', { ascending: true }),
    db.from('trucking_commodities').select('id, name, applies_surcharge, pricing_mode, qb_item_price, qb_item_id').eq('active', true).order('sort_order', { ascending: true }),
    db.from('trucking_customers').select('id, qb_customer_name').eq('active', true).order('sort_order', { ascending: true }),
    getTruckingSettings(),
    listSalesTerms().catch(() => []),
  ]);

  const customerRows = ((customers as { id: string; qb_customer_name: string }[]) || [])
    .map((c) => ({ id: c.id, name: c.qb_customer_name }));

  const commodityRows = ((commodities as { id: string; name: string; applies_surcharge: boolean; pricing_mode: string | null; qb_item_price: number | null; qb_item_id: string | null }[]) || [])
    .filter((c) => c.qb_item_id) // only ones mapped to a QB item can be invoiced
    .map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.pricing_mode || 'lane',
      appliesSurcharge: (c.pricing_mode || 'lane') === 'lane' && c.applies_surcharge !== false,
      unitPrice: c.qb_item_price != null ? Number(c.qb_item_price) : null,
    }));

  return NextResponse.json({
    ok: true,
    lanes: ((lanes as { id: string; origin: string; destination: string; rate_per_gallon: number }[]) || [])
      .map((l) => ({ id: l.id, origin: l.origin, destination: l.destination, rate: Number(l.rate_per_gallon) })),
    commodities: commodityRows,
    customers: customerRows,
    terms,
    surchargePct: settings.effectivePct,
    fuelPrice: settings.fuelPrice,
    fuelPricePeriod: settings.fuelPricePeriod,
    setupComplete: !!(customerRows.length > 0 && settings.qbSurchargeItemId && commodityRows.length > 0),
  });
}
