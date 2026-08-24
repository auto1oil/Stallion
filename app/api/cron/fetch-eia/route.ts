// GET /api/cron/fetch-eia — weekly (Mon/Tue) pull of the EIA Ultra-Low-Sulfur
// diesel retail price for Rocky Mountain (PADD 4), used to drive the trucking
// fuel surcharge. Runs from Vercel Cron (Authorization: Bearer $CRON_SECRET) or
// on demand by an admin (session cookie) via the Trucking settings "Refresh"
// button.
//
// Data source: EIA open-data API v2 (needs a free EIA_API_KEY env var). Series
// EMD_EPD2DXL0_PTE_R40_DPG = Weekly Rocky Mountain (PADD 4) No 2 Diesel Ultra
// Low Sulfur (0-15 ppm) Retail Prices, $/gal. Without a key the cron no-ops and
// admins can enter the price by hand in Trucking settings.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EIA_SERIES = 'EMD_EPD2DXL0_PTE_R40_DPG';

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → allow (dev)
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

async function isAdmin(): Promise<boolean> {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    return !!data && (data.role === 'admin' || data.role === 'master_admin');
  } catch { return false; }
}

async function run(): Promise<NextResponse> {
  const key = process.env.EIA_API_KEY;
  if (!key) {
    return NextResponse.json({
      ok: false,
      error: 'EIA_API_KEY is not set. Add a free EIA API key in Vercel to enable automatic price updates, or enter the price manually in Trucking settings.',
    }, { status: 400 });
  }

  // Latest weekly value from the EIA v2 data endpoint (the /seriesid shim 404s
  // for this series). Query the retail gasoline/diesel dataset filtered to our
  // series, newest period first.
  const params = new URLSearchParams();
  params.set('api_key', key);
  params.set('frequency', 'weekly');
  params.append('data[0]', 'value');
  params.append('facets[series][]', EIA_SERIES);
  params.append('sort[0][column]', 'period');
  params.append('sort[0][direction]', 'desc');
  params.set('length', '5');
  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?${params.toString()}`;

  let json: unknown;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const bodyText = await res.text();
    if (!res.ok) {
      // Surface EIA's own message (trimmed) so a wrong series/route is obvious.
      return NextResponse.json({ ok: false, error: `EIA request failed: ${res.status} ${bodyText.slice(0, 300)}` }, { status: 502 });
    }
    try { json = JSON.parse(bodyText); } catch { json = {}; }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'EIA fetch failed' }, { status: 502 });
  }

  const data = (json as { response?: { data?: Array<{ period?: string; value?: number | string }> } })?.response?.data || [];
  // Pick the row with the most recent period that has a numeric value.
  let best: { period: string; price: number } | null = null;
  for (const row of data) {
    const period = typeof row.period === 'string' ? row.period : null;
    const price = row.value == null ? NaN : Number(row.value);
    if (!period || !Number.isFinite(price)) continue;
    if (!best || period > best.period) best = { period, price };
  }
  if (!best) {
    return NextResponse.json({ ok: false, error: `EIA returned no rows for series ${EIA_SERIES}. The series ID may need adjusting — tell me and I'll fix it.` }, { status: 502 });
  }

  const db = createAdminClient();
  const { error } = await db.from('eia_diesel_prices')
    .upsert({ period: best.period, price: best.price, area: 'PADD4-ULSD', received_at: new Date().toISOString() },
            { onConflict: 'period' });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, period: best.period, price: best.price });
}

export async function GET(req: Request) {
  if (!cronAuthorized(req) && !(await isAdmin())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return run();
}

// Admins can also POST to force a refresh from the settings screen.
export async function POST(req: Request) {
  if (!cronAuthorized(req) && !(await isAdmin())) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return run();
}
