// App-side fuel tax rates — the source of truth for per-gallon fuel taxes.
//
// The fuel taxes never change, but QuickBooks has a habit of zeroing the rate
// on those tax items. So we keep the per-gallon rates in the app (app_settings
// key 'fuel_tax_rates', a JSON map of QB tax-item name → $/gal) and read from
// there. They can be seeded once from QuickBooks and edited by an admin.

import type { SupabaseClient } from '@supabase/supabase-js';
import { FUEL_TAX_ITEM_NAMES } from '@/lib/quickbooks';

export const FUEL_TAX_RATES_KEY = 'fuel_tax_rates';

// Read the stored per-gallon rate map (QB tax-item name → rate). Returns null
// if nothing has been saved yet.
export async function getStoredFuelTaxRates(db: SupabaseClient): Promise<Record<string, number> | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', FUEL_TAX_RATES_KEY).maybeSingle();
  if (!data?.value) return null;
  try {
    const parsed = JSON.parse(data.value) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = Number(v) || 0;
    return out;
  } catch {
    return null;
  }
}

// Given a name→rate map, total up the per-gallon tax for each fuel product and
// return both the totals and the per-tax breakdown.
export function taxByProductFromRates(rates: Record<string, number>) {
  const taxByProduct: Record<string, number> = {};
  const taxBreakdown: Record<string, { name: string; rate: number }[]> = {};
  for (const [product, names] of Object.entries(FUEL_TAX_ITEM_NAMES)) {
    let sum = 0;
    const parts: { name: string; rate: number }[] = [];
    for (const n of names) {
      const rate = Number(rates[n] ?? 0);
      sum += rate;
      parts.push({ name: n, rate });
    }
    taxByProduct[product] = sum;
    taxBreakdown[product] = parts;
  }
  return { taxByProduct, taxBreakdown };
}
