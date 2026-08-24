// ============================================================================
// DTN / Sinclair rack-price email parser + fuel price math
// ============================================================================
// The supplier (DTN Energy, on behalf of Sinclair) emails a plain-text rack
// price sheet. Each data row looks like:
//
//   WOODS CROSS, UT - HOLLY   05/27/26 18:00 #2 ULSD          -0.0444 4.3636
//   SALT LAKE CITY            05/27/26 18:00 #2 ULSD DYED      -0.0444 4.3686
//
// Columns: LOCATION  EFF-DATE  TIME  PRODUCT  CHANGE  PRICE.
// The PRICE is always the last number on the line and CHANGE is the signed
// number before it — those fixed shapes are what make this safe to parse.

export type RackPrice = {
  location: string;   // e.g. 'WOODS CROSS, UT - HOLLY'
  product: string;    // rack label, e.g. '#2 ULSD'
  effDate: string | null; // ISO 'YYYY-MM-DD'
  change: number | null;
  price: number;      // dollars per gallon
};

// location  date(MM/DD/YY)  time(H:MM)  product  change(±N.NNNN)  price(N.NNNN)
const ROW_RE =
  /^[>\s]*(.+?)\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2})\s+(.+?)\s+([+-]\d+\.\d+)\s+(\d+\.\d+)\s*$/;

function toIsoDate(mmddyy: string): string | null {
  const m = mmddyy.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  return `20${yy}-${mm}-${dd}`;
}

// Parse a pasted/forwarded rack-price email body into structured rows.
// Tolerant of forwarding artifacts (leading '>' quotes, extra whitespace);
// silently skips header, separator, START/END MSG and any non-data lines.
export function parseRackPriceEmail(body: string): RackPrice[] {
  const out: RackPrice[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(ROW_RE);
    if (!m) continue;
    const location = m[1].trim().replace(/\s+/g, ' ');
    const product = m[4].trim().replace(/\s+/g, ' ');
    const price = Number(m[6]);
    if (!location || !product || !Number.isFinite(price)) continue;
    const key = `${location}|||${product}`;
    if (seen.has(key)) continue; // first occurrence wins
    seen.add(key);
    out.push({
      location,
      product,
      effDate: toIsoDate(m[2]),
      change: Number.isFinite(Number(m[5])) ? Number(m[5]) : null,
      price,
    });
  }
  return out;
}

// Distinct, sorted locations / products from a parsed set (for mapping UI).
export function rackLocations(rows: RackPrice[]): string[] {
  return Array.from(new Set(rows.map((r) => r.location))).sort();
}
export function rackProducts(rows: RackPrice[]): string[] {
  return Array.from(new Set(rows.map((r) => r.product))).sort();
}

// Final price = rack base + per-customer markup (dollars per gallon).
// Rounded to 4 decimals to match the rack sheet's precision.
export function applyMarkup(base: number, markup: number): number {
  return Math.round((base + markup) * 10000) / 10000;
}

// ----------------------------------------------------------------------------
// Volume-tier pricing
// ----------------------------------------------------------------------------
// A tier is a gallon bracket with a markup ($/gal over rack). max_gallons null
// means "no upper bound". The markup for an order is the tier whose bracket
// contains the order's gallon count.

export type FuelTier = {
  min_gallons: number;
  max_gallons: number | null;
  markup: number;
  sort_order?: number;
};

// Sort tiers ascending by their lower bound (defensive — callers may pass them
// in any order).
export function sortTiers<T extends FuelTier>(tiers: T[]): T[] {
  return [...tiers].sort((a, b) => a.min_gallons - b.min_gallons);
}

// The markup for a given gallon count, or null if no tier matches. Gallons at
// or above the highest open-ended tier's min use that tier; a gallon count
// below the smallest tier falls back to the smallest tier so a price is always
// produced.
export function tierMarkupForGallons(tiers: FuelTier[], gallons: number): number | null {
  if (tiers.length === 0) return null;
  const sorted = sortTiers(tiers);
  for (const t of sorted) {
    const aboveMin = gallons >= t.min_gallons;
    const belowMax = t.max_gallons == null || gallons <= t.max_gallons;
    if (aboveMin && belowMax) return t.markup;
  }
  // Below the smallest bracket → use the smallest tier's markup.
  if (gallons < sorted[0].min_gallons) return sorted[0].markup;
  // Above everything (shouldn't happen if the top tier is open-ended) → top.
  return sorted[sorted.length - 1].markup;
}

// Convenience: final $/gal for an order given rack base, the applicable tier
// set, and gallons. Returns null when no rack base or no tiers.
export function tierPrice(base: number | null, tiers: FuelTier[], gallons: number): number | null {
  if (base == null) return null;
  const markup = tierMarkupForGallons(tiers, gallons);
  if (markup == null) return null;
  return applyMarkup(base, markup);
}
