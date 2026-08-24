// Tiny localStorage-backed cart. Lives only on the customer's browser so
// nothing here touches Supabase. The cart is committed to the DB at
// checkout — see /shop/checkout.

export type CartItem = {
  /** Null for custom lines added by the user — they're items we don't
   *  carry in the catalog yet, so they're not joined to products. */
  product_id: string | null;
  product_name: string;
  container_size: string;
  /** Brand is null on custom lines (we don't know which side of the
   *  bulk/package split they belong to). */
  brand: Brand | null;
  /** Oil weight (e.g. "0W-20") when the product has weight variants; null otherwise. */
  weight: string | null;
  quantity: number;
  notes?: string;
  /** Fuel-only: which terminal loading rack the fuel is pulled from
   *  (e.g. "Pioneer" / "Woodscross"). Null on non-fuel lines. */
  loading_rack?: string | null;
  /** Fuel-only: which fuel account the load bills against
   *  (e.g. "Auto 1 Oil", "Brad Hall", or a typed-in "Other"). Null on non-fuel. */
  fuel_account?: string | null;
  /** Admin-set unit price at order time (overrides the auto/retail price on the
   *  invoice). Null/undefined = use the normal pricing (fuel rack, retail…). */
  unit_price?: number | null;
  /** True for items added via the "Add custom item" button. */
  is_custom?: boolean;
};

// ── Brand split ──────────────────────────────────────────────────────────
// Bulk packaging (Auto 1) vs small package (Mag 1).
// Keep this list in sync with the migration that backfills order items.
const AUTO1_BULK_SIZES: ReadonlySet<string> = new Set([
  'GAL',
  '55-DRUM',
  '275-TOTE',
  '120LBS',
]);

export type Brand = 'Auto 1' | 'Mag 1';

export function brandFor(containerSize: string): Brand {
  return AUTO1_BULK_SIZES.has(containerSize) ? 'Auto 1' : 'Mag 1';
}

// Used in dropdowns to label each option with its brand,
// e.g. "BULK GAL — Auto 1" / "12/1CS — Mag 1".
export function sizeLabel(containerSize: string): string {
  return `${containerSize} — ${brandFor(containerSize)}`;
}

const CART_KEY = 'stallion-shop-cart-v1';

export function loadCart(): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Custom event name fired whenever the cart changes — listeners (e.g. the
 *  cart-icon badge in CustomerNavBar) react in real time without polling. */
export const CART_CHANGED_EVENT = 'stallion-cart-changed';

function fireCartChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CART_CHANGED_EVENT));
}

export function saveCart(items: CartItem[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CART_KEY, JSON.stringify(items));
  fireCartChanged();
}

export function clearCart() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(CART_KEY);
  fireCartChanged();
}

// Fallback list — products specify their own `container_sizes` array, so this
// is only used when something queries a product with an empty sizes list.
export const CONTAINER_SIZES = [
  'GAL',
  '55-DRUM',
  '275-TOTE',
  '5GL',
  '2.5GL',
  '3/1GL',
  '1/5GL',
  '6/1QT',
  '12/1QT',
  '3/5CS',
  '12/1CS',
  '6/1CS',
  '3/4CS',
  '30/14CS',
  '120LBS',
] as const;
