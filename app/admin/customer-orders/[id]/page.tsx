'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import CustomerDocuments from '@/components/CustomerDocuments';
import { type CartItem, CONTAINER_SIZES, brandFor } from '@/lib/cart';
import CustomItemButton from '@/components/CustomItemButton';
import { applyMarkup, tierMarkupForGallons, type FuelTier } from '@/lib/fuel-prices';

// Item names come from QuickBooks as "PACKAGING:PRODUCT" (e.g.
// "GAL:SUPREME UHP DEXOS 0W-20"). The packaging is already shown separately, so
// drop the leading "GAL:" prefix when displaying the name. Display only — the
// raw product_name is still used for matching/pricing.
const cleanItemName = (s: string) => {
  const i = (s || '').indexOf(':');
  return i >= 0 ? s.slice(i + 1).trim() : s;
};

type Product = {
  id: string;
  name: string;
  category: string;
  sort_order: number;
  container_sizes: string[] | null;
  weights: string[] | null;
  sizes_by_weight: Record<string, string[]> | null;
  variant_label: string;
  default_weight: string | null;
  default_container_size: string | null;
};

// A flat inventory item for the picker's "All items" mode + the per-line
// "match to stocked item" fixer. Admin-only page, so cost is fine here.
type StaffItem = { id: string; name: string; packaging: string | null; retail_price: number | null; cost: number | null };

type OrderRow = {
  id: string;
  status: string;
  invoice_number: string | null;
  invoice_pdf_path: string | null;
  delivery_address: string | null;
  notes: string | null;
  created_at: string;
  invoiced_at: string | null;
  dispatched_at: string | null;
  customer_id: string;
  sales_rep_id: string | null;
  submitted_by_id: string | null;
  dispatched_order_id: string | null;
  charge_tax: boolean | null;
  customer_order_items: Array<{
    id: string;
    product_id: string | null;
    product_name: string;
    container_size: string;
    brand: string | null;
    weight: string | null;
    quantity: number;
    notes: string | null;
    unit_price: number | null;
  }>;
  customer: { full_name: string | null; email: string; business_name: string | null; phone: string | null; business_id: string | null; business: { name: string | null } | null } | null;
  sales_rep: { full_name: string | null; email: string } | null;
  submitted_by: { full_name: string | null; email: string; role: string } | null;
};

const DISPATCH_TYPES = ['Fuel', 'PCMO', 'DEF', 'Shipping'] as const;

// Fuel products that require a per-invoice price + auto-append fuel taxes.
// Must stay in sync with FUEL_TAX_ITEM_NAMES in lib/quickbooks.ts.
const FUEL_PRODUCT_NAMES = new Set(['Clear Fuel', 'Dyed Fuel', '85-Octane', '91-Octane']);

// Color the price input relative to the default (matched retail) price:
//   at default            -> black
//   raised (above)        -> yellow, deepening to red the further up
//   lowered (below)       -> blue, deepening to green the further down
// `frac` is the deviation magnitude (0..1) where 1 = full saturation (~25%+).
function priceColor(entered: number | null, base: number | null): string {
  if (entered == null || base == null || base <= 0) return '#111827'; // black
  const dev = (entered - base) / base;
  const frac = Math.min(1, Math.abs(dev) / 0.25);
  if (Math.abs(dev) < 0.0005) return '#111827';
  // Interpolate hue: up = yellow(48)->red(0); down = blue(210)->green(140).
  const hue = dev > 0 ? 48 - 48 * frac : 210 - 70 * frac;
  const light = 42 - 6 * frac; // a touch darker as it saturates
  return `hsl(${hue} 85% ${light}%)`;
}

function statusBadge(s: string) {
  const m: Record<string, string> = {
    pending:    'bg-amber-50  text-amber-800  border-amber-200',
    invoiced:   'bg-blue-50   text-blue-800   border-blue-200',
    dispatched: 'bg-green-50  text-green-800  border-green-200',
    cancelled:  'bg-gray-100  text-gray-700   border-gray-300',
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${m[s] || ''}`}>
      {s}
    </span>
  );
}

function formatOrderForCopy(o: OrderRow): string {
  const lines: string[] = [];
  const cust = o.customer?.business_name || o.customer?.full_name || o.customer?.email || '';
  lines.push(`Customer: ${cust}`);
  if (o.customer?.email) lines.push(`Email: ${o.customer.email}`);
  if (o.customer?.phone) lines.push(`Phone: ${o.customer.phone}`);
  if (o.delivery_address) lines.push(`Deliver to: ${o.delivery_address}`);
  lines.push('');
  lines.push('Items:');
  o.customer_order_items.forEach((it) => {
    const wsuffix = it.weight ? ` ${it.weight}` : '';
    lines.push(`  ${it.quantity} × ${cleanItemName(it.product_name)}${wsuffix} — ${it.container_size}`);
  });
  if (o.notes) {
    lines.push('');
    lines.push(`Customer notes: ${o.notes}`);
  }
  return lines.join('\n');
}

export default function AdminCustomerOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params?.id as string;
  const supabase = createClient();
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [billingNotes, setBillingNotes] = useState<string | null>(null);
  const [chargeTax, setChargeTax] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // UI state for the invoice & dispatch forms
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [dispatchType, setDispatchType] = useState<typeof DISPATCH_TYPES[number]>('PCMO');
  const [dispatchTruck, setDispatchTruck] = useState('');
  const [qbConnected, setQbConnected] = useState<boolean | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoResult, setAutoResult] = useState<string>('');
  // Per-line unit-price override entered by the admin (string from the input,
  // parsed before posting). Keyed by customer_order_items.id. Required for
  // fuel lines (priced fresh each invoice); optional override for everything
  // else (otherwise QB falls back to billing history / item default).
  const [linePrices, setLinePrices] = useState<Record<string, string>>({});
  // Auto-price breakdown per fuel product name (rack base + customer markup).
  const [autoFuel, setAutoFuel] = useState<Record<string, { base: number; markup: number; total: number }>>({});
  // Local override of item quantities for snappy input UX. Falls through to
  // the persisted value when no override is set. Saved to DB on blur.
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [picker, setPicker] = useState<Product | null>(null);
  // Cost + sales price per order variant, from matched inventory items (admin
  // only; never shown to customers).
  const [invMatch, setInvMatch] = useState<Map<string, { cost: number | null; retail: number | null }>>(new Map());
  // Full active inventory (retail only) for the picker's "All items" mode, so an
  // admin can add ANY stocked item here — not just the curated catalog families.
  const [allItems, setAllItems] = useState<StaffItem[]>([]);
  // Per-line price source chosen with the "match to stocked item" fixer — shows
  // that item's cost/retail for the line and fills its price (overrides a broken
  // or zero-priced auto-match). Keyed by order-line id.
  const [lineOverride, setLineOverride] = useState<Record<string, { cost: number | null; retail: number | null; name: string }>>({});
  const [showProductList, setShowProductList] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  // Admin "change customer" — fix a wrong business before the order is invoiced.
  const [changeCust, setChangeCust] = useState(false);
  type CustOpt = { id: string; full_name: string | null; business_name: string | null; email: string; business: { name: string | null } | null };
  const [custList, setCustList] = useState<CustOpt[]>([]);
  const [custSearch, setCustSearch] = useState('');
  const [custBusy, setCustBusy] = useState(false);
  // Label a customer the way the Customers tab does: linked business name first,
  // then the profile's own business_name, then the person/email.
  const custLabel = (c: CustOpt) => c.business?.name || c.business_name || c.full_name || c.email;

  async function openChangeCustomer() {
    setChangeCust(true);
    setCustSearch('');
    if (custList.length === 0) {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, business_name, email, business:businesses!profiles_business_id_fkey(name)')
        .eq('role', 'customer')
        .order('business_name', { ascending: true, nullsFirst: false })
        .order('email');
      setCustList((data as unknown as CustOpt[]) || []);
    }
  }

  async function reassignCustomer(customerId: string) {
    if (!order) return;
    setCustBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/order-set-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.id, customer_id: customerId }),
      });
      const j = await res.json();
      if (!j.ok) { setError(j.error || 'Could not change the customer.'); return; }
      setChangeCust(false);
      setCustSearch('');
      await load();
    } catch {
      setError('Could not change the customer — please try again.');
    } finally {
      setCustBusy(false);
    }
  }

  // Re-link this customer's business to a live QuickBooks customer (fixes
  // "customer was deleted/merged" when the right record still exists in QB).
  const [relink, setRelink] = useState(false);
  const [qbSearch, setQbSearch] = useState('');
  const [qbResults, setQbResults] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [qbSearching, setQbSearching] = useState(false);
  const [relinkBusy, setRelinkBusy] = useState(false);

  async function runQbSearch() {
    const q = qbSearch.trim();
    if (q.length < 2) { setQbResults([]); return; }
    setQbSearching(true);
    try {
      const res = await fetch(`/api/quickbooks/search-customers?q=${encodeURIComponent(q)}`);
      const j = await res.json();
      setQbResults(j.ok ? j.customers : []);
      if (!j.ok) setError(j.error || 'QuickBooks search failed.');
    } catch { setError('QuickBooks search failed.'); }
    finally { setQbSearching(false); }
  }

  async function relinkTo(qbId: string, qbName: string) {
    const bizId = order?.customer?.business_id;
    if (!bizId) { setError('This customer has no linked business to re-link.'); return; }
    setRelinkBusy(true); setError('');
    try {
      const res = await fetch('/api/admin/relink-qb-customer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, qb_customer_id: qbId, qb_customer_name: qbName }),
      });
      const j = await res.json();
      if (!j.ok) { setError(j.error || 'Could not re-link.'); return; }
      setRelink(false); setQbSearch(''); setQbResults([]);
      await load();
    } catch { setError('Could not re-link — please try again.'); }
    finally { setRelinkBusy(false); }
  }

  async function load() {
    setLoading(true);
    const [orderRes, qbRes, prodRes, invRes] = await Promise.all([
      supabase
        .from('customer_orders')
        .select(`
          *,
          customer_order_items(*),
          customer:profiles!customer_orders_customer_id_fkey(full_name, email, business_name, phone, business_id, business:businesses!profiles_business_id_fkey(name)),
          sales_rep:profiles!customer_orders_sales_rep_id_fkey(full_name, email),
          submitted_by:profiles!customer_orders_submitted_by_id_fkey(full_name, email, role)
        `)
        .eq('id', orderId)
        .single(),
      supabase
        .from('quickbooks_connection')
        .select('id')
        .eq('id', 1)
        .maybeSingle(),
      supabase
        .from('products')
        .select('id, name, category, sort_order, container_sizes, weights, sizes_by_weight, variant_label, default_weight, default_container_size')
        .eq('active', true)
        .order('sort_order'),
      supabase
        .from('inventory_items')
        .select('match_product_id, match_weight, match_container_size, cost, retail_price')
        .not('match_product_id', 'is', null),
    ]);
    const o = orderRes.data as unknown as OrderRow;
    setOrder(o);
    setChargeTax(!!o?.charge_tax);
    if (o?.invoice_number) setInvoiceNumber(o.invoice_number);
    // Pull the customer's special billing instructions so the biller sees them.
    if (o?.customer?.business_id) {
      supabase.from('businesses').select('billing_notes').eq('id', o.customer.business_id).maybeSingle()
        .then(({ data }) => setBillingNotes((data as { billing_notes: string | null } | null)?.billing_notes ?? null));
    } else {
      setBillingNotes(null);
    }
    setQbConnected(!!qbRes.data);
    setProducts((prodRes.data as Product[]) || []);
    const im = new Map<string, { cost: number | null; retail: number | null }>();
    ((invRes.data as { match_product_id: string; match_weight: string | null; match_container_size: string | null; cost: number | null; retail_price: number | null }[]) || [])
      .forEach((r) => {
        const key = `${r.match_product_id}|${r.match_weight || ''}|${r.match_container_size || ''}`;
        const existing = im.get(key);
        // When two inventory items map to the same product/variant, keep the one
        // with a real retail price so a $0/blank duplicate can't hide a properly
        // priced item (last-one-wins would otherwise blank the line).
        if (existing && (existing.retail ?? 0) >= (r.retail_price ?? 0)) return;
        im.set(key, { cost: r.cost, retail: r.retail_price });
      });
    setInvMatch(im);
    // Pre-fill non-fuel line prices with the matched inventory retail price, so
    // the default sale price is the starting point (admin can adjust up/down).
    setLinePrices((prev) => {
      const next = { ...prev };
      for (const it of o.customer_order_items) {
        if (FUEL_PRODUCT_NAMES.has(it.product_name)) continue;
        if (next[it.id]) continue; // don't clobber an existing edit
        // A price saved on the line (e.g. set by the "match to stocked item"
        // fixer) wins over the auto-matched retail so the fix survives a reload.
        if (it.unit_price != null) { next[it.id] = Number(it.unit_price).toFixed(2); continue; }
        const m = im.get(`${it.product_id || ''}|${it.weight || ''}|${it.container_size || ''}`);
        if (m?.retail != null) next[it.id] = m.retail.toFixed(2);
      }
      return next;
    });
    setQtyDraft({});
    setLoading(false);
    if (o) loadFuelAutoPricing(o);
  }

  // Compute rack price + the volume-tier markup for each fuel line and
  // pre-fill the price box, so the admin sees the right per-gallon price
  // automatically (they can still override before invoicing). The markup is
  // chosen by the line's gallons, using the customer's own tiers when they
  // have special pricing, otherwise the default tiers. Keyed by line id since
  // two lines of the same product can fall in different volume tiers.
  async function loadFuelAutoPricing(o: OrderRow) {
    const fuelItems = o.customer_order_items.filter((it) => FUEL_PRODUCT_NAMES.has(it.product_name));
    // Auto-pick the dispatch type from the order's contents so one-click
    // confirm→warehouse stamps the right type (Fuel vs PCMO).
    setDispatchType(fuelItems.length > 0 ? 'Fuel' : 'PCMO');
    if (fuelItems.length === 0) { setAutoFuel({}); return; }
    const fuelNames = Array.from(new Set(fuelItems.map((it) => it.product_name)));
    const bizId = o.customer?.business_id || null;

    const [mapRes, defTierRes, custTierRes, bizRes] = await Promise.all([
      supabase.from('fuel_price_mappings').select('app_product, rack_location, rack_product').in('app_product', fuelNames),
      supabase.from('fuel_pricing_tiers').select('min_gallons, max_gallons, markup, sort_order'),
      bizId
        ? supabase.from('customer_fuel_tiers').select('min_gallons, max_gallons, markup, sort_order').eq('business_id', bizId)
        : Promise.resolve({ data: [] as FuelTier[] }),
      bizId
        ? supabase.from('businesses').select('fuel_special_pricing').eq('id', bizId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const maps = (mapRes.data as { app_product: string; rack_location: string; rack_product: string }[]) || [];
    if (maps.length === 0) { setAutoFuel({}); return; }

    const special = !!(bizRes.data as { fuel_special_pricing?: boolean } | null)?.fuel_special_pricing;
    const custTiers = (custTierRes.data as FuelTier[]) || [];
    const defTiers = (defTierRes.data as FuelTier[]) || [];
    const tiers = special && custTiers.length ? custTiers : defTiers;

    // Latest rack price per mapped product.
    const baseByProduct = new Map<string, number>();
    await Promise.all(maps.map(async (mp) => {
      const { data } = await supabase
        .from('rack_prices')
        .select('price')
        .eq('location', mp.rack_location)
        .eq('product', mp.rack_product)
        .order('eff_date', { ascending: false, nullsFirst: false })
        .order('received_at', { ascending: false })
        .limit(1);
      const base = data && data[0] ? Number((data[0] as { price: number }).price) : null;
      if (base != null) baseByProduct.set(mp.app_product, base);
    }));

    // One entry per fuel line: rack base + tier markup picked by its gallons.
    const info: Record<string, { base: number; markup: number; total: number }> = {};
    for (const it of fuelItems) {
      const base = baseByProduct.get(it.product_name);
      if (base == null) continue;
      const markup = tierMarkupForGallons(tiers, it.quantity) ?? 0;
      info[it.id] = { base, markup, total: applyMarkup(base, markup) };
    }
    setAutoFuel(info);

    // Pre-fill any empty fuel price boxes with the computed total.
    setLinePrices((prev) => {
      const next = { ...prev };
      for (const it of fuelItems) {
        if (!next[it.id] && info[it.id]) {
          next[it.id] = String(info[it.id].total);
        }
      }
      return next;
    });
  }

  async function saveItemQty(itemId: string, raw: string) {
    if (!order) return;
    const qty = parseInt(raw, 10);
    if (!qty || qty < 1) {
      // Restore from server value — invalid input is discarded silently.
      setQtyDraft((d) => { const { [itemId]: _drop, ...rest } = d; return rest; });
      return;
    }
    const current = order.customer_order_items.find((it) => it.id === itemId);
    if (!current || current.quantity === qty) {
      setQtyDraft((d) => { const { [itemId]: _drop, ...rest } = d; return rest; });
      return;
    }
    setEditBusy(true); setError('');
    const { error: err } = await supabase
      .from('customer_order_items')
      .update({ quantity: qty })
      .eq('id', itemId);
    setEditBusy(false);
    if (err) { setError(err.message); return; }
    setQtyDraft((d) => { const { [itemId]: _drop, ...rest } = d; return rest; });
    load();
  }

  async function removeItem(itemId: string) {
    if (!order) return;
    if (order.customer_order_items.length === 1) {
      setError("Can't remove the last item. Cancel the order instead.");
      return;
    }
    if (!confirm('Remove this item from the order?')) return;
    setEditBusy(true); setError('');
    const { error: err } = await supabase
      .from('customer_order_items')
      .delete()
      .eq('id', itemId);
    setEditBusy(false);
    if (err) { setError(err.message); return; }
    setLinePrices((p) => { const { [itemId]: _drop, ...rest } = p; return rest; });
    load();
  }

  // Price a line from a chosen stocked item — fixes a line whose auto-match is
  // missing, zero-priced, or pointed at the wrong product. It:
  //  1) shows that item's cost/retail for this line + fills its sale price,
  //  2) saves the price on the line so it sticks across reloads, and
  //  3) (for catalog/quick products) re-points the stocked item's default match
  //     to THIS product, so every future order of it prices from this item —
  //     i.e. the fix "carries over" instead of being per-order only.
  async function applyLineMatch(
    line: { id: string; product_id: string | null; weight: string | null; container_size: string },
    pick: StaffItem,
  ) {
    setLineOverride((prev) => ({ ...prev, [line.id]: { cost: pick.cost, retail: pick.retail_price, name: pick.name } }));
    if (pick.retail_price != null) {
      setLinePrices((prev) => ({ ...prev, [line.id]: pick.retail_price!.toFixed(2) }));
    }
    await supabase.from('customer_order_items').update({ unit_price: pick.retail_price }).eq('id', line.id);
    if (line.product_id) {
      await supabase.from('inventory_items').update({
        match_product_id: line.product_id,
        match_weight: line.weight || null,
        match_container_size: line.container_size || null,
      }).eq('id', pick.id);
      // Reflect the new match locally so this line (and any sibling line for the
      // same product) reports the item's cost/retail right away.
      setInvMatch((prev) => {
        const next = new Map(prev);
        next.set(`${line.product_id || ''}|${line.weight || ''}|${line.container_size || ''}`, { cost: pick.cost, retail: pick.retail_price });
        return next;
      });
    }
  }

  async function addItem(item: CartItem) {
    if (!order) return;
    // Merge into an existing matching line if one is already on the order,
    // mirroring the salesman cart logic so admins don't get duplicates.
    const existing = order.customer_order_items.find((it) =>
      it.product_name === item.product_name
      && it.container_size === item.container_size
      && (it.weight || null) === (item.weight || null)
      && (it.brand || null) === (item.brand || null),
    );

    setEditBusy(true); setError('');
    if (existing) {
      const { error: err } = await supabase
        .from('customer_order_items')
        .update({ quantity: existing.quantity + item.quantity })
        .eq('id', existing.id);
      setEditBusy(false);
      if (err) { setError(err.message); return; }
    } else {
      const { error: err } = await supabase
        .from('customer_order_items')
        .insert({
          customer_order_id: order.id,
          product_id: item.product_id,
          product_name: item.product_name,
          container_size: item.container_size,
          brand: item.brand,
          weight: item.weight,
          quantity: item.quantity,
          notes: item.notes || null,
        });
      setEditBusy(false);
      if (err) { setError(err.message); return; }
    }
    setPicker(null);
    setShowProductList(false);
    load();
  }

  useEffect(() => { load(); }, [orderId]);

  // Full active inventory for the picker's "All items" mode and the per-line
  // "match to stocked item" fixer. Direct read (admin page → RLS allows it) so
  // we get cost too, which the fixer shows alongside retail.
  useEffect(() => {
    supabase
      .from('inventory_items')
      .select('id, description, qb_name, packaging, retail_price, cost')
      .eq('active', true)
      .order('packaging')
      .order('description')
      .then(({ data }) => {
        setAllItems(((data as { id: string; description: string | null; qb_name: string; packaging: string | null; retail_price: number | null; cost: number | null }[]) || [])
          .map((r) => ({ id: r.id, name: r.description || r.qb_name, packaging: r.packaging, retail_price: r.retail_price, cost: r.cost })));
      });
  }, [supabase]);

  async function createInvoiceViaQB() {
    if (!order) return;

    // Collect every entered price as a per-line override. Fuel lines are
    // required (priced fresh each invoice — daily, per-customer). Non-fuel
    // lines are optional: if blank, QB uses the customer's billing history
    // or the item's default UnitPrice.
    const line_prices: Record<string, number> = {};
    for (const it of order.customer_order_items) {
      const raw = (linePrices[it.id] || '').trim();
      const isFuel = FUEL_PRODUCT_NAMES.has(it.product_name);
      if (!raw) {
        if (isFuel) {
          setError(`Enter a per-gallon price for ${it.product_name}${it.weight ? ' ' + it.weight : ''} before creating the invoice.`);
          return;
        }
        continue;
      }
      const v = parseFloat(raw);
      if (isNaN(v) || v < 0) {
        setError(`Invalid price for ${it.product_name}${it.weight ? ' ' + it.weight : ''}.`);
        return;
      }
      line_prices[it.id] = v;
    }

    setAutoBusy(true);
    setAutoResult('');
    setError('');
    try {
      const res = await fetch('/api/quickbooks/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The API param is `fuel_prices` historically but is just a generic
        // per-line UnitPrice override map keyed by item id.
        body: JSON.stringify({ customer_order_id: order.id, fuel_prices: line_prices, charge_tax: chargeTax }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || 'QuickBooks invoice failed.');
        setAutoBusy(false);
        return;
      }
      const parts = [
        `Created QB invoice ${json.invoice?.docNumber || json.invoice?.id}`,
        json.invoice?.totalAmt != null ? `($${json.invoice.totalAmt.toFixed(2)})` : null,
        `for ${json.customer?.name || 'customer'}.`,
      ].filter(Boolean);
      if (json.matched) {
        const m = json.matched;
        const labels: string[] = [];
        if (m.mapping)      labels.push(`${m.mapping} from mapping`);
        if (m.history)      labels.push(`${m.history} from history`);
        if (m.name)         labels.push(`${m.name} by name match`);
        if (m.auto_created) labels.push(`${m.auto_created} auto-created`);
        if (labels.length) parts.push(`(${labels.join(', ')})`);
      }
      if (Array.isArray(json.tax_lines_added) && json.tax_lines_added.length > 0) {
        parts.push(`Added ${json.tax_lines_added.length} fuel-tax line${json.tax_lines_added.length === 1 ? '' : 's'}.`);
      }
      if (json.customer_tax_exempt) {
        parts.push('Customer is sales-tax exempt (TC-721 on file).');
      }
      if (json.pdf_attached) parts.push('Invoice PDF attached to order.');
      if (json.pdf_warning) parts.push(`⚠ ${json.pdf_warning}`);
      parts.push('Sending to the warehouse…');
      setAutoResult(parts.join(' '));
      setAutoBusy(false);
      // One click: invoiced → send straight to the warehouse (creates the
      // dispatch row and lands you on the Orders board in Warehouse).
      await convertToDispatch();
    } catch (e: any) {
      setError(e.message || 'Network error.');
      setAutoBusy(false);
    }
  }

  async function viewInvoicePdf() {
    if (!order?.invoice_pdf_path) return;
    const { data, error: err } = await supabase.storage
      .from('invoices')
      .createSignedUrl(order.invoice_pdf_path, 300);
    if (err || !data) {
      setError(`Could not get PDF link: ${err?.message || 'unknown'}`);
      return;
    }
    window.open(data.signedUrl, '_blank');
  }

  async function copyOrderSummary() {
    if (!order) return;
    const text = formatOrderForCopy(order);
    try {
      await navigator.clipboard.writeText(text);
      alert('Order details copied — paste into QuickBooks.');
    } catch {
      prompt('Copy this:', text);
    }
  }

  async function markInvoiced() {
    if (!order) return;
    if (!invoiceNumber.trim()) {
      setError('Enter the QuickBooks invoice number first.');
      return;
    }
    setBusy(true); setError('');
    const { error: err } = await supabase
      .from('customer_orders')
      .update({
        invoice_number: invoiceNumber.trim(),
        status: 'invoiced',
        invoiced_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    if (err) { setBusy(false); setError(err.message); return; }
    // Match the one-click QB-invoice flow: once it's invoiced, send it straight
    // to the warehouse. Otherwise a manually-invoiced admin order stalls at
    // "invoiced" and keeps reappearing on the Confirm page.
    await convertToDispatch();
  }

  async function convertToDispatch() {
    if (!order) return;
    setBusy(true); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    // Pull the latest invoice #/PDF straight from the DB — when this runs right
    // after Create invoice, the local `order` state may not have them yet.
    const { data: fresh } = await supabase
      .from('customer_orders')
      .select('invoice_number, invoice_pdf_path')
      .eq('id', order.id)
      .single();
    const invoiceNumber = fresh?.invoice_number ?? order.invoice_number;
    const invoicePdfPath = fresh?.invoice_pdf_path ?? order.invoice_pdf_path;
    // Every order needs an invoice before it can go to the warehouse.
    if (!invoiceNumber) {
      setError('Create the QuickBooks invoice first — every order needs an invoice before the warehouse.');
      setBusy(false);
      return;
    }
    // Tie the dispatch order to the linked BUSINESS name first (matches the
    // Customers tab + QuickBooks), then fall back to the profile's fields.
    let bizName: string | null = null;
    if (order.customer?.business_id) {
      const { data: biz } = await supabase.from('businesses').select('name').eq('id', order.customer.business_id).maybeSingle();
      bizName = biz?.name ?? null;
    }
    const customerLabel =
      bizName ||
      order.customer?.business_name ||
      order.customer?.full_name ||
      order.customer?.email ||
      'Customer';

    const itemSummary = order.customer_order_items
      .map((it) => `${it.quantity} × ${cleanItemName(it.product_name)} (${it.container_size})`)
      .join('\n');
    const noteParts = [
      `From customer order #${order.id.slice(0, 8)}`,
      `Items:\n${itemSummary}`,
    ];
    if (order.notes) noteParts.push(`Customer notes: ${order.notes}`);
    if (order.delivery_address) noteParts.push(`Deliver to: ${order.delivery_address}`);

    // Whoever placed the customer order (a sales rep ordering on the
    // customer's behalf, or the customer themselves) rides along on the
    // dispatch row so it's visible at every stage if questions come up.
    const placedByName =
      order.submitted_by?.full_name || order.submitted_by?.email ||
      order.customer?.full_name || order.customer?.email || null;

    // Insert ONLY guaranteed base columns; placed_by / placed_by_name /
    // entry_method were added by a later migration and go in a best-effort
    // update so a DB missing them still gets the dispatch row instead of the
    // confirm button failing and the order staying stuck in approval.
    const { data: dispatchOrder, error: insErr } = await supabase
      .from('orders')
      .insert({
        date: new Date().toISOString().split('T')[0],
        customer: customerLabel,
        type: dispatchType,
        truck: dispatchTruck.trim() || null,
        invoice_number: invoiceNumber,
        invoice_pdf_path: invoicePdfPath,    // QB invoice PDF carries through
        notes: noteParts.join('\n\n'),
        created_by: user?.id || null,
      })
      .select('id')
      .single();

    if (insErr || !dispatchOrder) {
      setError(insErr?.message || 'Could not create dispatch order.');
      setBusy(false);
      return;
    }
    await supabase
      .from('orders')
      .update({ placed_by: order.submitted_by_id || order.customer_id, placed_by_name: placedByName, entry_method: 'placed' })
      .eq('id', dispatchOrder.id);

    const { error: updErr } = await supabase
      .from('customer_orders')
      .update({
        status: 'dispatched',
        dispatched_order_id: dispatchOrder.id,
        dispatched_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    setBusy(false);
    if (updErr) { setError(updErr.message); return; }
    router.push(`/admin?dispatched=${dispatchOrder.id}`);
  }

  async function cancelOrder() {
    if (!order) return;
    if (!confirm('Cancel this order? The customer will see it as cancelled.')) return;
    setBusy(true); setError('');
    const { error: err } = await supabase
      .from('customer_orders')
      .update({ status: 'cancelled' })
      .eq('id', order.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    load();
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!order) return <p className="text-sm text-gray-500">Order not found.</p>;

  const isPending = order.status === 'pending';
  const isInvoiced = order.status === 'invoiced';
  const isDispatched = order.status === 'dispatched';
  const isCancelled = order.status === 'cancelled';

  return (
    <div>
      <Link href="/admin/customer-orders" className="text-sm text-gray-500 hover:text-gray-900">
        ← All customer orders
      </Link>

      <div className="flex items-center justify-between gap-2 flex-wrap mt-2 mb-4">
        <h1 className="text-2xl font-semibold">
          Order <span className="font-mono text-base text-gray-500">#{order.id.slice(0, 8)}</span>
        </h1>
        <div className="flex items-center gap-2">
          {statusBadge(order.status)}
          {order.submitted_by_id && order.submitted_by_id !== order.customer_id && order.submitted_by?.role === 'salesman' && (
            <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full border bg-indigo-50 text-indigo-800 border-indigo-200">
              sales rep submitted
            </span>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        Placed {new Date(order.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
        {order.submitted_by_id && order.submitted_by_id !== order.customer_id && order.submitted_by ? (
          <> · Submitted by <span className="font-medium">{order.submitted_by.full_name || order.submitted_by.email}</span> on behalf of customer</>
        ) : (order.customer?.full_name || order.customer?.email) ? (
          <> · Placed by <span className="font-medium">{order.customer?.full_name || order.customer?.email}</span></>
        ) : null}
      </p>

      {billingNotes && billingNotes.trim() && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 mb-1">⚠ Billing instructions</div>
          <div className="text-sm text-amber-900 whitespace-pre-wrap">{billingNotes}</div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Customer</h2>
            {!order.invoiced_at && !order.dispatched_order_id && !relink && (
              <div className="flex items-center gap-3">
                {changeCust
                  ? <button onClick={() => { setChangeCust(false); setCustSearch(''); }} className="text-xs text-gray-500 hover:underline">Cancel</button>
                  : <button onClick={openChangeCustomer} className="text-xs text-brand-700 hover:underline font-medium">Change</button>}
                {!changeCust && (
                  <button onClick={() => { setRelink(true); setQbSearch(order.customer?.business?.name || order.customer?.full_name || ''); setError(''); }}
                    className="text-xs text-brand-700 hover:underline font-medium">Re-link QB</button>
                )}
              </div>
            )}
            {relink && (
              <button onClick={() => { setRelink(false); setQbResults([]); }} className="text-xs text-gray-500 hover:underline">Cancel</button>
            )}
          </div>
          {relink ? (
            <div>
              <p className="text-[11px] text-gray-500 mb-1">Search your live QuickBooks customers and pick the correct record to link this customer to.</p>
              <div className="flex gap-2">
                <input autoFocus value={qbSearch} onChange={(e) => setQbSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runQbSearch(); }}
                  placeholder="Search QuickBooks customers…"
                  className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm" />
                <button onClick={runQbSearch} disabled={qbSearching} className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50">
                  {qbSearching ? '…' : 'Search'}
                </button>
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded">
                {qbResults.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-gray-400">{qbSearching ? 'Searching…' : 'No results yet — search a name.'}</div>
                ) : (
                  qbResults.map((c) => (
                    <button key={c.id} disabled={relinkBusy} onClick={() => relinkTo(c.id, c.name)}
                      className="block w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50">
                      <span className="font-medium">{c.name}</span>
                      <span className="block text-[11px] text-gray-500">{c.email || 'no email'}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (<></>)}
          {changeCust ? (
            <div>
              <input
                autoFocus
                value={custSearch}
                onChange={(e) => setCustSearch(e.target.value)}
                placeholder="Search customers by business / name / email…"
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              />
              <p className="text-[11px] text-amber-700 mt-1">Pick the correct customer — this reassigns the order before it&apos;s invoiced.</p>
              <div className="mt-2 max-h-56 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded">
                {custList.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-gray-400">Loading customers…</div>
                ) : (
                  custList
                    .filter((c) => {
                      const n = custSearch.trim().toLowerCase();
                      if (!n) return true;
                      return `${c.business?.name || ''} ${c.business_name || ''} ${c.full_name || ''} ${c.email}`.toLowerCase().includes(n);
                    })
                    .slice(0, 30)
                    .map((c) => (
                      <button
                        key={c.id}
                        disabled={custBusy || c.id === order.customer_id}
                        onClick={() => reassignCustomer(c.id)}
                        className="block w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
                      >
                        <span className="font-medium">{custLabel(c)}</span>
                        {c.id === order.customer_id && <span className="text-[11px] text-gray-400"> · current</span>}
                        <span className="block text-[11px] text-gray-500">{c.full_name ? `${c.full_name} · ` : ''}{c.email}</span>
                      </button>
                    ))
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm space-y-1">
              <div className="font-medium">{order.customer?.business?.name || order.customer?.business_name || order.customer?.full_name || order.customer?.email}</div>
              {order.customer?.full_name && (order.customer?.business?.name || order.customer?.business_name) && (
                <div className="text-gray-600">{order.customer.full_name}</div>
              )}
              {order.customer?.email && <div className="text-gray-600">{order.customer.email}</div>}
              {order.customer?.phone && <div className="text-gray-600">{order.customer.phone}</div>}
            </div>
          )}
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Delivery</h2>
          <div className="text-sm space-y-1">
            <div className="whitespace-pre-wrap">{order.delivery_address || <span className="text-gray-400">no address</span>}</div>
            <div className="text-gray-600">
              Sales rep: {order.sales_rep ? (order.sales_rep.full_name || order.sales_rep.email) : <span className="text-gray-400">none</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Customer File — collapsed by default so the order approval workflow
          (items + Step 1) is visible without scrolling past the docs. Admin
          can expand when they need to verify a profile sheet, TC-721, or W-9. */}
      <details className="bg-white border border-gray-200 rounded-lg mb-6 group">
        <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between hover:bg-gray-50 rounded-lg">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Customer File
          </span>
          <span className="text-xs text-gray-400 group-open:hidden">
            Profile sheet · TC-721 · W-9
          </span>
          <span className="text-xs text-gray-400 hidden group-open:inline">
            Hide
          </span>
        </summary>
        <div className="px-4 pb-4 pt-1 border-t border-gray-100">
          <CustomerDocuments customerId={order.customer_id} />
        </div>
      </details>

      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Items</h2>
        {isPending && order.customer_order_items.some((it) => FUEL_PRODUCT_NAMES.has(it.product_name)) && (
          <span className="text-xs text-amber-700">
            Fuel lines require a per-gallon price · taxes auto-added
          </span>
        )}
      </div>
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 mb-3">
        {order.customer_order_items.map((it) => {
          const isFuel = FUEL_PRODUCT_NAMES.has(it.product_name);
          const qtyValue = qtyDraft[it.id] ?? String(it.quantity);
          return (
            <div key={it.id} className="px-4 py-2.5 flex justify-between items-center gap-3 flex-wrap">
              <div className="text-sm flex-1 min-w-[160px]">
                <div className="font-medium">{cleanItemName(it.product_name)}{it.weight ? ' ' + it.weight : ''}</div>
                <div className="text-xs text-gray-500">{it.container_size}</div>
                {(() => {
                  // A per-line override (from the "match to stocked item" fixer)
                  // wins over the auto-match, so a broken/zero-priced match can
                  // be corrected right here.
                  const m = lineOverride[it.id] || invMatch.get(`${it.product_id || ''}|${it.weight || ''}|${it.container_size || ''}`);
                  if (!m || (m.cost == null && m.retail == null)) return null;
                  const enteredStr = linePrices[it.id] ?? '';
                  const entered = enteredStr.trim() === '' ? null : Number(enteredStr);
                  const hasEntered = entered != null && !Number.isNaN(entered);
                  // Below/at cost -> red+bold (losing money); at/above retail -> green.
                  const belowCost = hasEntered && m.cost != null && (entered as number) <= m.cost;
                  const atRetail = hasEntered && m.retail != null && (entered as number) >= m.retail;
                  return (
                    <div className="text-xs text-gray-500 mt-0.5">
                      {m.cost != null && (
                        <span className={belowCost ? 'text-red-600 font-bold' : ''}>Cost ${m.cost.toFixed(2)}</span>
                      )}
                      {m.cost != null && m.retail != null && <span> · </span>}
                      {m.retail != null && (
                        <span className={atRetail ? 'text-emerald-600 font-semibold' : ''}>Sells ${m.retail.toFixed(2)}</span>
                      )}
                      {belowCost && <span className="text-red-600 font-bold"> · below cost!</span>}
                    </div>
                  );
                })()}
                {isPending && !isFuel && (
                  <LineMatcher
                    items={allItems}
                    currentName={lineOverride[it.id]?.name || null}
                    onPick={(pick) => applyLineMatch(it, pick)}
                  />
                )}
              </div>
              {isPending ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-500">×</span>
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={qtyValue}
                      onChange={(e) => setQtyDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                      onBlur={(e) => saveItemQty(it.id, e.target.value)}
                      disabled={editBusy}
                      className="w-16 px-2 py-1.5 border border-gray-300 rounded-md text-sm text-center tabular-nums"
                    />
                  </div>
                  {(() => {
                    const baseRetail = isFuel
                      ? null
                      : (lineOverride[it.id]?.retail ?? invMatch.get(`${it.product_id || ''}|${it.weight || ''}|${it.container_size || ''}`)?.retail ?? null);
                    const enteredStr = linePrices[it.id] ?? '';
                    const entered = enteredStr.trim() === '' ? null : Number(enteredStr);
                    const color = isFuel ? undefined : priceColor(Number.isNaN(entered as number) ? null : entered, baseRetail);
                    return (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm ${isFuel ? 'text-amber-700' : 'text-gray-500'}`}>$</span>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        inputMode="decimal"
                        value={linePrices[it.id] || ''}
                        onChange={(e) => setLinePrices((prev) => ({ ...prev, [it.id]: e.target.value }))}
                        placeholder={isFuel ? '0.000' : (baseRetail != null ? baseRetail.toFixed(2) : 'QB price')}
                        style={color ? { color, fontWeight: 600 } : undefined}
                        className={`w-24 px-2 py-1.5 border rounded-md text-sm tabular-nums ${isFuel ? 'border-amber-300 bg-amber-50' : 'border-gray-300'}`}
                      />
                      <span className="text-xs text-gray-500">{isFuel ? '/ gal' : 'ea'}</span>
                    </div>
                    {isFuel && autoFuel[it.id] && (
                      <span className="text-[10px] text-gray-500">
                        auto: rack ${autoFuel[it.id].base.toFixed(4)}
                        {autoFuel[it.id].markup ? ` + $${autoFuel[it.id].markup.toFixed(2)} over rack` : ''}
                        {' = '}${autoFuel[it.id].total.toFixed(4)}
                      </span>
                    )}
                  </div>
                    );
                  })()}
                  <button
                    onClick={() => removeItem(it.id)}
                    disabled={editBusy}
                    title="Remove item"
                    className="text-red-600 text-xs px-2 py-1 rounded hover:text-red-800 hover:bg-red-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </>
              ) : (
                <div className="text-sm tabular-nums">× {it.quantity}</div>
              )}
            </div>
          );
        })}
      </div>
      {isPending && (
        <div className="mb-3">
          {!showProductList ? (
            <button
              onClick={() => setShowProductList(true)}
              className="text-sm text-brand-700 hover:underline font-medium"
            >
              + Add product
            </button>
          ) : (
            <ProductPickerList
              products={products}
              items={allItems}
              onPick={(p) => setPicker(p)}
              onPickItem={(it) => addItem({
                product_id: null,
                product_name: it.name,
                container_size: it.packaging || '—',
                brand: null,
                weight: null,
                quantity: 1,
              })}
              onCancel={() => setShowProductList(false)}
            />
          )}
        </div>
      )}

      {/* Custom item box — at the bottom for items not in the catalog yet. */}
      {isPending && (
        <div className="mb-6">
          <CustomItemButton onAdd={addItem} />
        </div>
      )}

      {order.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-1">Customer notes</h2>
          <p className="text-sm text-amber-900 whitespace-pre-wrap">{order.notes}</p>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {/* STEP 1: QuickBooks invoice */}
      {(isPending || isInvoiced) && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="font-semibold mb-1">Step 1 — Create QuickBooks invoice</h2>

          {/* Automatic path — only when QB is connected */}
          {qbConnected === true && (
            <>
              <p className="text-sm text-gray-600 mb-3">
                Create the invoice in QuickBooks automatically. Matches (or auto-creates)
                the customer and line items, applies QB pricing, and records the invoice
                number here.
              </p>

              <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
                <input type="checkbox" checked={chargeTax} disabled={isInvoiced}
                  onChange={(e) => setChargeTax(e.target.checked)} className="w-4 h-4" />
                <span className="font-medium">Charge sales tax</span>
                <span className="text-xs text-gray-500">— check for customers that owe tax (not applied to fuel).</span>
              </label>

              <button
                onClick={createInvoiceViaQB}
                disabled={autoBusy || isInvoiced}
                className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
              >
                {autoBusy ? 'Creating in QuickBooks…' : (isInvoiced ? 'Already invoiced' : 'Create QB invoice')}
              </button>
              {autoResult && (
                <p className="text-sm text-green-700 mt-2">{autoResult}</p>
              )}
              <div className="my-4 border-t border-gray-200" />
              <p className="text-xs text-gray-500 mb-3">
                Or do it manually if the automatic flow can't match something:
              </p>
            </>
          )}

          {qbConnected === false && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-3 text-sm">
              QuickBooks isn't connected yet. <Link href="/admin/quickbooks" className="font-medium underline">Connect it</Link> to skip manual entry.
            </div>
          )}

          <div className="flex gap-2 flex-wrap mb-3">
            <button
              onClick={copyOrderSummary}
              className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Copy order to clipboard
            </button>
            <a
              href="https://app.qbo.intuit.com/app/invoice"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Open QuickBooks ↗
            </a>
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <label className="block text-xs font-medium text-gray-700 mb-1">QuickBooks invoice #</label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="e.g. 1234"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
            <button
              onClick={markInvoiced}
              disabled={busy}
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              {isInvoiced ? 'Update invoice #' : 'Mark invoiced manually'}
            </button>
          </div>
          {order.invoiced_at && (
            <p className="text-xs text-gray-500 mt-2">
              Invoiced {new Date(order.invoiced_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          )}
          {order.invoice_pdf_path && (
            <button
              onClick={viewInvoicePdf}
              className="mt-2 text-sm text-brand-700 hover:underline"
            >
              📄 View QB invoice PDF
            </button>
          )}
        </div>
      )}

      {/* STEP 2: Convert to dispatch */}
      {isInvoiced && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="font-semibold mb-1">Step 2 — Convert to dispatch</h2>
          <p className="text-sm text-gray-600 mb-3">
            Send this to your drivers. Creates a row in the regular Orders list ready
            for driver assignment.
          </p>
          <div className="grid sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Order type</label>
              <select
                value={dispatchType}
                onChange={(e) => setDispatchType(e.target.value as typeof DISPATCH_TYPES[number])}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                {DISPATCH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Truck <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={dispatchTruck}
                onChange={(e) => setDispatchTruck(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>
          </div>
          <button
            onClick={convertToDispatch}
            disabled={busy}
            className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
          >
            {busy ? 'Working…' : 'Convert to dispatch →'}
          </button>
        </div>
      )}

      {isDispatched && order.dispatched_order_id && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <h2 className="font-semibold text-green-900">Dispatched</h2>
          <p className="text-sm text-green-900 mt-1">
            {order.dispatched_at && `On ${new Date(order.dispatched_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. `}
            <Link href={`/admin?highlight=${order.dispatched_order_id}`} className="font-medium underline">
              View in Orders →
            </Link>
          </p>
        </div>
      )}

      {isCancelled && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
          <p className="text-sm text-gray-700">This order was cancelled.</p>
        </div>
      )}

      {!isCancelled && !isDispatched && (
        <button
          onClick={cancelOrder}
          disabled={busy}
          className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
        >
          Cancel this order
        </button>
      )}

      {picker && (
        <AddProductDialog
          product={picker}
          onCancel={() => setPicker(null)}
          onAdd={addItem}
        />
      )}
    </div>
  );
}

// Per-order-line "price this line from a stocked item" fixer. Searchable list
// of every active inventory item; picking one sets the line's cost/retail
// display + fills its sale price. Used to correct a line whose auto-match is
// missing or zero-priced (the "below cost / $0.00" case).
function LineMatcher({ items, currentName, onPick }: {
  items: StaffItem[];
  currentName: string | null;
  onPick: (it: StaffItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[11px] text-brand-700 hover:underline mt-0.5">
        {currentName ? `Priced from: ${currentName} · change` : '+ Match to stocked item'}
      </button>
    );
  }

  const needle = q.trim().toLowerCase();
  const list = (needle ? items.filter((i) => `${i.name} ${i.packaging || ''}`.toLowerCase().includes(needle)) : items).slice(0, 40);

  return (
    <div className="mt-1 w-full max-w-xs">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search stocked items…"
        className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white"
      />
      <div className="mt-1 border border-gray-200 rounded max-h-48 overflow-y-auto bg-white divide-y divide-gray-100">
        {list.length === 0 ? (
          <div className="px-2 py-2 text-xs text-gray-400">No matches.</div>
        ) : list.map((i) => (
          <button
            key={i.id}
            onClick={() => { onPick(i); setOpen(false); setQ(''); }}
            className="w-full text-left px-2 py-1.5 text-xs hover:bg-gray-50 flex justify-between gap-2"
          >
            <span className="truncate">{i.name}{i.packaging ? ` · ${i.packaging}` : ''}</span>
            <span className="text-gray-500 whitespace-nowrap">{i.retail_price != null ? `$${i.retail_price.toFixed(2)}` : '—'}</span>
          </button>
        ))}
      </div>
      <button onClick={() => { setOpen(false); setQ(''); }} className="text-[11px] text-gray-400 hover:underline mt-1">Cancel</button>
    </div>
  );
}

function ProductPickerList({ products, items, onPick, onPickItem, onCancel }: {
  products: Product[];
  items: StaffItem[];
  onPick: (p: Product) => void;
  onPickItem: (it: StaffItem) => void;
  onCancel: () => void;
}) {
  // "catalog" = the curated product families (pick weight/size in a dialog).
  // "all" = every stocked inventory item, added straight to the order.
  const [mode, setMode] = useState<'catalog' | 'all'>('catalog');
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();

  const grouped: Record<string, Product[]> = {};
  const categoryOrder: string[] = [];
  products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
    .forEach((p) => {
      if (!(p.category in grouped)) {
        grouped[p.category] = [];
        categoryOrder.push(p.category);
      }
      grouped[p.category].push(p);
    });

  const filteredItems = items.filter(
    (it) => !q || `${it.name} ${it.packaging || ''}`.toLowerCase().includes(q),
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex gap-1">
          {([['catalog', 'Catalog'], ['all', 'All items']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`px-2.5 py-1 text-xs rounded-md border ${mode === key ? 'border-brand-700 text-brand-700 bg-brand-50 font-semibold' : 'border-gray-200 text-gray-500 hover:text-gray-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-900 px-2">
          Cancel
        </button>
      </div>
      <input
        type="text"
        placeholder={mode === 'all' ? 'Search all items…' : 'Search products…'}
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-md text-sm"
      />
      {mode === 'catalog' ? (
        categoryOrder.length === 0 ? (
          <p className="text-sm text-gray-500 py-3 text-center">No matching products.</p>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {categoryOrder.map((cat) => (
              <div key={cat}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{cat}</h3>
                <div className="border border-gray-200 rounded-md divide-y divide-gray-100">
                  {grouped[cat].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onPick(p)}
                      className="w-full flex justify-between items-center px-3 py-2 hover:bg-gray-50 text-left"
                    >
                      <span className="text-sm">{p.name}</span>
                      <span className="text-brand-700 font-medium text-sm whitespace-nowrap">+ Add</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : filteredItems.length === 0 ? (
        <p className="text-sm text-gray-500 py-3 text-center">{items.length === 0 ? 'No inventory items.' : 'No matches.'}</p>
      ) : (
        <div className="border border-gray-200 rounded-md divide-y divide-gray-100 max-h-96 overflow-y-auto">
          {filteredItems.map((it) => (
            <button
              key={it.id}
              onClick={() => onPickItem(it)}
              className="w-full flex justify-between items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left"
            >
              <span className="min-w-0">
                <span className="text-sm block truncate">{it.name}</span>
                <span className="text-xs text-gray-500">
                  {it.packaging || '—'}{it.retail_price != null ? ` · $${it.retail_price.toFixed(2)}` : ''}
                </span>
              </span>
              <span className="text-brand-700 font-medium text-sm whitespace-nowrap shrink-0">+ Add</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddProductDialog({ product, onAdd, onCancel }: {
  product: Product;
  onAdd: (item: CartItem) => void;
  onCancel: () => void;
}) {
  const defaultSizes = product.container_sizes && product.container_sizes.length > 0
    ? product.container_sizes
    : (CONTAINER_SIZES as readonly string[]);
  const weights = product.weights || [];
  const hasWeights = weights.length > 0;
  const sizesByWeight = product.sizes_by_weight || {};

  const initialWeight = hasWeights
    ? (product.default_weight && weights.includes(product.default_weight) ? product.default_weight : weights[0])
    : '';
  const [weight, setWeight] = useState<string>(initialWeight);
  const sizesForWeight = (w: string): readonly string[] => {
    if (w && sizesByWeight[w] && sizesByWeight[w].length > 0) return sizesByWeight[w];
    return defaultSizes;
  };
  const currentSizes = sizesForWeight(initialWeight);

  const initialSize =
    product.default_container_size && currentSizes.includes(product.default_container_size)
      ? product.default_container_size
      : currentSizes[0];
  const [size, setSize] = useState<string>(initialSize);
  const [qty, setQty] = useState<string>('');

  function onWeightChange(newWeight: string) {
    setWeight(newWeight);
    const next = sizesForWeight(newWeight);
    if (!next.includes(size)) setSize(next[0]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = parseInt(qty, 10);
    if (!q || q < 1) return;
    onAdd({
      product_id: product.id,
      product_name: product.name,
      container_size: size,
      brand: brandFor(size),
      weight: hasWeights ? weight : null,
      quantity: q,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-lg max-w-sm w-full p-6">
        <h2 className="text-lg font-semibold mb-1">{product.name}</h2>
        <p className="text-xs text-gray-500 mb-4">{product.category}</p>
        <form onSubmit={submit} className="space-y-3">
          {hasWeights && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{product.variant_label || 'Weight'}</label>
              <select
                value={weight}
                onChange={(e) => onWeightChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
              >
                {weights.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Container size</label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
            >
              {currentSizes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number" min={1} value={qty} autoFocus
              onChange={(e) => setQty(e.target.value)}
              placeholder="e.g. 4"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
            />
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <button type="button" onClick={onCancel}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
            <button type="submit"
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md font-medium">Add to order</button>
          </div>
        </form>
      </div>
    </div>
  );
}
