'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { sortTiers, applyMarkup, type FuelTier } from '@/lib/fuel-prices';

// "Today's Fuel Prices" quick-glance box (shown on /driver and the admin Fuel
// page). Pricing moved to rack price + volume-tier markup, so this computes
// each product's price live from the same source the order flow uses:
//   fuel_price_mappings (app product -> rack line) + latest rack_prices +
//   fuel_pricing_tiers. We show rack + the markup of the tier an admin flagged
//   (`display_in_widget`) on the Fuel Pricing page, falling back to the lowest
//   tier if none is flagged. The exact price still varies by order volume. We
//   never show the bare rack price (cost) — a markup is always applied.

type DisplayTier = FuelTier & { display_in_widget?: boolean };

// The DTN/Sinclair rack sheet arrives the evening before it takes effect, so
// its eff_date is the day it went out and the price applies the NEXT day. Show
// that next-day date in the box. Accepts 'YYYY-MM-DD' or an ISO timestamp.
function nextDayLabel(ymd: string | null): string | null {
  if (!ymd) return null;
  const m = ymd.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1); // +1 day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PRODUCTS = ['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane'] as const;

type Row = { product: string; price: number | null; withTax: number | null };
type Mapping = { app_product: string; rack_location: string; rack_product: string };

export default function FuelPricesWidget() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: maps }, { data: tierData }, taxRes] = await Promise.all([
        supabase.from('fuel_price_mappings').select('app_product, rack_location, rack_product'),
        supabase.from('fuel_pricing_tiers').select('min_gallons, max_gallons, markup, sort_order, display_in_widget'),
        fetch('/api/fuel-prices/tax-totals').then((r) => r.json()).catch(() => ({})),
      ]);
      const taxByProduct = (taxRes?.taxByProduct || {}) as Record<string, number>;

      const tiers = sortTiers((tierData as DisplayTier[]) || []);
      // Use the admin-flagged tier; fall back to the lowest tier if none set.
      const chosen = tiers.find((t) => t.display_in_widget) ?? tiers[0];
      const baseMarkup = chosen ? Number(chosen.markup) : null;

      const mapByProduct = new Map<string, Mapping>();
      for (const m of (maps as Mapping[]) || []) mapByProduct.set(m.app_product, m);

      // Latest rack price per mapped product, in parallel.
      const results = await Promise.all(
        PRODUCTS.map(async (product) => {
          const mp = mapByProduct.get(product);
          if (!mp || baseMarkup == null) return { product, price: null, withTax: null, priceDate: null } as const;
          const { data: rp } = await supabase
            .from('rack_prices')
            .select('price, eff_date, received_at')
            .eq('location', mp.rack_location)
            .eq('product', mp.rack_product)
            .order('eff_date', { ascending: false, nullsFirst: false })
            .order('received_at', { ascending: false })
            .limit(1);
          const row = rp && rp[0]
            ? (rp[0] as { price: number; eff_date: string | null; received_at: string })
            : null;
          if (!row) return { product, price: null, withTax: null, priceDate: null } as const;
          const price = applyMarkup(Number(row.price), baseMarkup);
          const tax = Number(taxByProduct[product] ?? 0);
          return {
            product,
            price,
            withTax: Math.round((price + tax) * 1000) / 1000,
            // Base the displayed (next-day) date on eff_date, falling back to
            // when it was received.
            priceDate: (row.eff_date ?? row.received_at)?.slice(0, 10) ?? null,
          } as const;
        }),
      );

      const latestBase = results
        .map((r) => r.priceDate)
        .filter((v): v is string => !!v)
        .sort()
        .pop() ?? null;

      setRows(results.map((r) => ({ product: r.product, price: r.price, withTax: r.withTax })));
      setAsOf(nextDayLabel(latestBase));
      setLoading(false);
    })();
  }, []);

  if (loading) return null;
  // Nothing priced yet (no mappings, rack prices, or tiers) — hide the box.
  if (rows.every((r) => r.price == null)) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-semibold text-brand-900 text-sm">Today's Fuel Prices</h2>
        {asOf && <span className="text-xs text-gray-400">{asOf}</span>}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 text-sm">
        <span></span>
        <span className="text-[10px] uppercase tracking-wide text-gray-400 text-right">No tax</span>
        <span className="text-[10px] uppercase tracking-wide text-gray-400 text-right">With tax</span>
        {rows.map((r) => (
          <div key={r.product} className="contents">
            <span className="text-gray-700 py-0.5">{r.product}</span>
            <span className="font-medium tabular-nums text-right py-0.5">
              {r.price != null ? `$${r.price.toFixed(3)}` : '—'}
            </span>
            <span className="font-semibold tabular-nums text-right py-0.5 text-brand-900">
              {r.withTax != null ? `$${r.withTax.toFixed(3)}` : '—'}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-2">
        Rack + the selected volume markup. With-tax adds the per-gallon fuel taxes. Final price varies by order volume.
      </p>
    </div>
  );
}
