// /api/trucking/settings — admin read/write of trucking settings.
//
// GET  → current settings + resolved surcharge % + latest EIA price.
// POST → save chosen QB customer/items, manual surcharge override, base/step.
// Also used (GET) by the driver create form via /api/trucking/quote which reads
// the same settings server-side.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { getTruckingSettings } from '@/lib/trucking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, status: 401 as const, error: 'not signed in' };
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return { ok: false as const, status: 403 as const, error: 'admin required' };
  }
  return { ok: true as const };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  const settings = await getTruckingSettings();
  return NextResponse.json({ ok: true, settings });
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // Map incoming fields → app_settings keys. Only keys present in the body are
  // written, so a partial save doesn't wipe the rest.
  const FIELDS: Record<string, string> = {
    qbCustomerId: 'trucking_qb_customer_id',
    qbCustomerName: 'trucking_qb_customer_name',
    qbFreightItemId: 'trucking_qb_freight_item_id',
    qbFreightItemName: 'trucking_qb_freight_item_name',
    qbSurchargeItemId: 'trucking_qb_surcharge_item_id',
    qbSurchargeItemName: 'trucking_qb_surcharge_item_name',
    manualPct: 'trucking_surcharge_manual_pct',
    basePrice: 'trucking_surcharge_base_price',
    step: 'trucking_surcharge_step',
  };

  const rows: { key: string; value: string }[] = [];
  for (const [field, key] of Object.entries(FIELDS)) {
    if (!(field in body)) continue;
    const v = body[field];
    rows.push({ key, value: v == null ? '' : String(v).trim() });
  }
  if (rows.length) {
    const db = createAdminClient();
    const { error } = await db.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const settings = await getTruckingSettings();
  return NextResponse.json({ ok: true, settings });
}
