// Trucking (freight) invoicing helpers — server only.
//
// Fuel surcharge: a percentage of the freight amount, driven by the weekly EIA
// Ultra-Low-Sulfur diesel price (Rocky Mountain, PADD 4). Per Addendum #1 the
// surcharge is 0% at $3.00 and rises 1% per $0.15 of fuel price, rounded UP:
//   pct = ceil((price - 3.00) / 0.15)   (min 0)
// Verified against the sample invoice: price 5.285 → ceil(2.285/0.15)=16%.

import { createAdminClient } from '@/lib/supabase-admin';

export type TruckingSettings = {
  qbCustomerId: string;
  qbCustomerName: string;
  qbFreightItemId: string;
  qbFreightItemName: string;
  qbSurchargeItemId: string;
  qbSurchargeItemName: string;
  manualPct: number | null;      // manual override; null = auto from EIA
  basePrice: number;             // fuel price at which surcharge = 0%
  step: number;                  // $ of fuel price per +1%
  fuelPrice: number | null;      // latest EIA ULSD price
  fuelPricePeriod: string | null;// EIA period (yyyy-mm-dd)
  computedPct: number;           // % computed from the latest EIA price
  effectivePct: number;          // what invoices actually use (manual ?? computed)
};

export function computeSurchargePct(price: number, base = 3.0, step = 0.15): number {
  if (!Number.isFinite(price) || price <= base) return 0;
  return Math.ceil((price - base) / step);
}

// QuickBooks line Amount = round(UnitPrice × Qty) to cents, using integer math
// so it matches QB exactly (avoids the error-6070 penny mismatch). Same formula
// as lib/quickbooks' qbLineAmount; duplicated here to price the freight line
// (and the surcharge that's a % of it) before we build the invoice.
export function freightAmount(rate: number, qty: number): number {
  return Math.round((Math.round(rate * 1e5) * qty) / 1e3) / 100;
}

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Read all trucking settings + the latest EIA price, and resolve the effective
// surcharge %. Uses the admin (service-role) client so it works from any server
// route regardless of the caller's role (app_settings is admin-read only).
export async function getTruckingSettings(): Promise<TruckingSettings> {
  const db = createAdminClient();

  const [{ data: rows }, { data: eia }] = await Promise.all([
    db.from('app_settings').select('key, value').like('key', 'trucking_%'),
    db.from('eia_diesel_prices').select('period, price').order('period', { ascending: false }).limit(1),
  ]);

  const map = new Map<string, string>();
  for (const r of (rows as { key: string; value: string }[]) || []) map.set(r.key, r.value ?? '');
  const get = (k: string) => map.get(k) ?? '';

  const basePrice = num(get('trucking_surcharge_base_price')) ?? 3.0;
  const step = num(get('trucking_surcharge_step')) ?? 0.15;
  const manualPct = num(get('trucking_surcharge_manual_pct'));

  const latest = (eia as { period: string; price: number }[] | null)?.[0] ?? null;
  const fuelPrice = latest ? Number(latest.price) : null;
  const fuelPricePeriod = latest ? latest.period : null;

  const computedPct = fuelPrice != null ? computeSurchargePct(fuelPrice, basePrice, step) : 0;
  const effectivePct = manualPct != null ? manualPct : computedPct;

  return {
    qbCustomerId: get('trucking_qb_customer_id'),
    qbCustomerName: get('trucking_qb_customer_name'),
    qbFreightItemId: get('trucking_qb_freight_item_id'),
    qbFreightItemName: get('trucking_qb_freight_item_name'),
    qbSurchargeItemId: get('trucking_qb_surcharge_item_id'),
    qbSurchargeItemName: get('trucking_qb_surcharge_item_name'),
    manualPct,
    basePrice,
    step,
    fuelPrice,
    fuelPricePeriod,
    computedPct,
    effectivePct,
  };
}
