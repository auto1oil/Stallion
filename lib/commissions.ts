// Salesman commission engine.
//
// Computes, for a date range, each salesman's gross profit + commission from
// their assigned customers' QuickBooks invoices. Rules (set per customer on the
// business): commission_percent = % of GROSS PROFIT (sale − item cost) on every
// non-fuel line; fuel is EITHER that same % OR a flat $/gallon (never both).
// Excise/fee/cleanup tax lines are pass-through and excluded from profit.
//
// Profit = invoice line Amount − (QuickBooks item PurchaseCost × Qty).

import type { SupabaseClient } from '@supabase/supabase-js';
import { qbFetch, listAllItems, FUEL_TAX_ITEM_NAMES } from '@/lib/quickbooks';
import { GASOLINE_RE } from '@/lib/fuel-detect';

const ALL_TAX_NAMES = new Set(Object.values(FUEL_TAX_ITEM_NAMES).flat().map((n) => n.toLowerCase()));

function bare(name: string): string {
  const s = (name || '').toLowerCase().trim();
  const i = s.lastIndexOf(':');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}
function isTaxLine(name: string): boolean {
  const b = bare(name);
  return ALL_TAX_NAMES.has(b) || /\b(tax|excise|lust|hazard|envir|cleanup|fee|spill)\b/.test(b);
}
function isFuelLine(name: string): boolean {
  if (isTaxLine(name)) return false;
  const b = bare(name);
  if (/dyed/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  if (/clear/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  return GASOLINE_RE.test(b);
}

type QBInvLine = {
  DetailType?: string;
  Amount?: number;
  SalesItemLineDetail?: {
    ItemRef?: { value?: string; name?: string };
    Qty?: number;
    UnitPrice?: number;
    ClassRef?: { value?: string; name?: string };
  };
};
type QBInv = { CustomerRef?: { value?: string }; TxnDate?: string; Line?: QBInvLine[]; ClassRef?: { value?: string; name?: string } };

export type CustomerCommission = {
  businessId: string;
  name: string;
  sale: number;
  profit: number;
  gallons: number;
  commission: number;
  // Diagnostics: non-fuel sale that found no item cost (so it counted as full
  // margin), plus a few example item names, to surface gaps in item costs.
  uncostedSale: number;
  uncostedItems: string[];
};
export type SalesmanCommission = {
  repId: string;
  repName: string;
  totalSale: number;
  totalProfit: number;
  totalCommission: number;
  customers: CustomerCommission[];
};

type BizRow = {
  id: string; name: string; qb_customer_id: string | null; assigned_sales_rep_id: string | null;
  commission_percent: number | null; fuel_commission_mode: string | null; fuel_commission_per_gallon: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function computeCommissions(
  db: SupabaseClient,
  fromISO: string,
  toISO: string,
  repFilter?: string | null,
): Promise<{ salesmen: SalesmanCommission[]; invoices: number }> {
  // Every QuickBooks-linked customer (we credit by the invoice's salesman Class
  // and fall back to the customer's assigned rep, so we can't pre-filter by
  // assigned rep — an unassigned customer can still have Class-tagged sales).
  const { data: bizData } = await db
    .from('businesses')
    .select('id, name, qb_customer_id, assigned_sales_rep_id, commission_percent, fuel_commission_mode, fuel_commission_per_gallon')
    .not('qb_customer_id', 'is', null);
  const bizRows = (bizData as BizRow[]) || [];
  const bizByQb = new Map<string, BizRow>();
  for (const b of bizRows) if (b.qb_customer_id) bizByQb.set(String(b.qb_customer_id), b);
  if (bizByQb.size === 0) return { salesmen: [], invoices: 0 };

  // Salesman attribution: map a QuickBooks Class name to a salesman via
  // profiles.qb_class. Fuel lines use a "<class> fuel" sub-class, so strip a
  // trailing " fuel" before matching. Each invoice line is credited to its
  // Class's salesman, falling back to the customer's assigned rep.
  const repByClass = new Map<string, string>();
  const { data: classReps } = await db
    .from('profiles').select('id, qb_class').not('qb_class', 'is', null);
  for (const r of (classReps as { id: string; qb_class: string | null }[]) || []) {
    if (r.qb_class) repByClass.set(r.qb_class.trim().toLowerCase(), r.id);
  }
  const classToRep = (className?: string): string | null => {
    if (!className) return null;
    const b = bare(className).replace(/\s+fuel$/, '').trim();
    return repByClass.get(b) || null;
  };

  // Rep display names — for assigned reps and Class-mapped reps alike.
  const repIdSet = new Set<string>();
  for (const b of bizRows) if (b.assigned_sales_rep_id) repIdSet.add(b.assigned_sales_rep_id);
  for (const id of repByClass.values()) repIdSet.add(id);
  const repName = new Map<string, string>();
  if (repIdSet.size) {
    const { data: reps } = await db.from('profiles').select('id, full_name, email').in('id', Array.from(repIdSet));
    for (const r of (reps as { id: string; full_name: string | null; email: string }[]) || []) {
      repName.set(r.id, r.full_name || r.email);
    }
  }

  // Item costs (PurchaseCost) by QuickBooks item id.
  const items = await listAllItems();
  const costById = new Map<string, number>();
  for (const it of items) if (it.PurchaseCost != null) costById.set(it.Id, Number(it.PurchaseCost));

  // App-maintained item costs (inventory_items.cost) as a fallback for items
  // whose QuickBooks record carries no PurchaseCost. Without this, those lines
  // cost $0 and "gross profit" comes out equal to the full sale — so a 10%
  // commission is really 10% of sales, not 10% of margin. Keyed by the QB item
  // name and its bare child name so an invoice line can find it either way.
  const invCostByName = new Map<string, number>();
  const invCostBySku = new Map<string, number>();
  const { data: invRows } = await db.from('inventory_items').select('qb_name, sku, cost');
  for (const r of (invRows as { qb_name: string | null; sku: string | null; cost: number | null }[]) || []) {
    if (r.cost == null || !(Number(r.cost) > 0)) continue;
    const c = Number(r.cost);
    if (r.qb_name) {
      invCostByName.set(r.qb_name.trim().toLowerCase(), c);
      const b = bare(r.qb_name);
      if (b && !invCostByName.has(b)) invCostByName.set(b, c);
    }
    if (r.sku) invCostBySku.set(r.sku.trim().toLowerCase(), c);
  }
  // Bridge: QuickBooks item id -> app inventory cost, matched through the item's
  // name and SKU. This lets a line that references an item by id pick up the
  // maintained cost even when QB's live PurchaseCost is blank AND the line's
  // ItemRef.name doesn't match (QB often returns just the leaf name, or none).
  const invCostById = new Map<string, number>();
  for (const it of items) {
    const full = (it.FullyQualifiedName || it.Name || '').trim().toLowerCase();
    const c =
      invCostByName.get(full) ??
      invCostByName.get(bare(it.FullyQualifiedName || it.Name || '')) ??
      (it.Sku ? invCostBySku.get(it.Sku.trim().toLowerCase()) : undefined);
    if (c != null) invCostById.set(it.Id, c);
  }

  // Fuel cost basis. QuickBooks fuel items carry no per-gallon purchase cost —
  // fuel cost is the daily rack price (the order/invoice flow prices fuel as
  // rack + markup). So costing fuel by PurchaseCost (which is $0) counts the
  // whole fuel sale as profit and massively overstates gross profit for
  // fuel-heavy customers. Instead, cost each fuel line at the rack price that
  // was in effect on the invoice date, making fuel gross profit the over-rack
  // markup. Falls back to the QB item cost when no rack price is available.
  const { data: mapData } = await db
    .from('fuel_price_mappings').select('app_product, rack_location, rack_product');
  const rackKeyByProduct = new Map<string, string>(); // app_product -> "location|||product"
  for (const m of (mapData as { app_product: string; rack_location: string; rack_product: string }[]) || []) {
    if (m.rack_location && m.rack_product) rackKeyByProduct.set(m.app_product, `${m.rack_location}|||${m.rack_product}`);
  }
  // Rack price history per mapped (location, product), newest eff_date first.
  const rackHist = new Map<string, { eff: string; price: number }[]>();
  if (rackKeyByProduct.size) {
    const keys = Array.from(rackKeyByProduct.values());
    const locs = Array.from(new Set(keys.map((k) => k.split('|||')[0])));
    const prods = Array.from(new Set(keys.map((k) => k.split('|||')[1])));
    const { data: rp } = await db
      .from('rack_prices').select('location, product, eff_date, price')
      .in('location', locs).in('product', prods)
      .not('eff_date', 'is', null)
      .order('eff_date', { ascending: false });
    for (const r of (rp as { location: string; product: string; eff_date: string; price: number }[]) || []) {
      const k = `${r.location}|||${r.product}`;
      const arr = rackHist.get(k) || [];
      arr.push({ eff: r.eff_date, price: Number(r.price) });
      rackHist.set(k, arr);
    }
  }
  // Map a QB fuel line's item name to one of our app fuel products.
  function fuelProductOf(name: string): string | null {
    const b = bare(name);
    if (/dyed/.test(b)) return 'Dyed Fuel';
    if (/clear/.test(b)) return 'Clear Fuel';
    if (GASOLINE_RE.test(b)) return /91/.test(b) ? '91-Octane' : '85-Octane';
    return null;
  }
  // Rack price per gallon for a product as of a date (newest eff_date <= date).
  function rackCostPerGal(product: string, date?: string): number | null {
    const key = rackKeyByProduct.get(product);
    if (!key) return null;
    const hist = rackHist.get(key);
    if (!hist || hist.length === 0) return null;
    if (date) { for (const h of hist) if (h.eff <= date) return h.price; } // sorted desc
    return hist[0].price; // newest known price
  }

  // All invoices in the range (paginated).
  const invoices: QBInv[] = [];
  let start = 1; const page = 200;
  while (true) {
    const q = `select * from Invoice where TxnDate >= '${fromISO}' and TxnDate <= '${toISO}' startposition ${start} maxresults ${page}`;
    const res = await qbFetch<{ QueryResponse: { Invoice?: QBInv[] } }>(`/query?query=${encodeURIComponent(q)}`);
    const batch = res.QueryResponse.Invoice || [];
    invoices.push(...batch);
    if (batch.length < page) break;
    start += page;
  }

  // Aggregate per rep + per customer.
  const reps = new Map<string, SalesmanCommission>();
  const custKey = (repId: string, bizId: string) => `${repId}|${bizId}`;
  const custMap = new Map<string, CustomerCommission>();

  for (const inv of invoices) {
    const qbCust = inv.CustomerRef?.value;
    if (!qbCust) continue;
    const biz = bizByQb.get(String(qbCust));
    if (!biz) continue;
    const pct = biz.commission_percent != null ? Number(biz.commission_percent) : 0;
    const fuelMode = biz.fuel_commission_mode === 'per_gallon' ? 'per_gallon' : 'percent';
    const perGal = biz.fuel_commission_per_gallon != null ? Number(biz.fuel_commission_per_gallon) : 0;
    const invClass = inv.ClassRef?.name;

    for (const line of inv.Line || []) {
      if (line.DetailType !== 'SalesItemLineDetail') continue;
      const d = line.SalesItemLineDetail!;
      const name = d.ItemRef?.name || '';
      if (isTaxLine(name)) continue;               // pass-through tax — not margin
      // Credit this line to the salesman tagged on it (QB Class), else the
      // customer's assigned rep.
      const repId = classToRep(d.ClassRef?.name || invClass) || biz.assigned_sales_rep_id;
      if (!repId) continue;
      if (repFilter && repId !== repFilter) continue;

      let rep = reps.get(repId);
      if (!rep) { rep = { repId, repName: repName.get(repId) || 'Salesman', totalSale: 0, totalProfit: 0, totalCommission: 0, customers: [] }; reps.set(repId, rep); }
      const ck = custKey(repId, biz.id);
      let cust = custMap.get(ck);
      if (!cust) { cust = { businessId: biz.id, name: biz.name, sale: 0, profit: 0, gallons: 0, commission: 0, uncostedSale: 0, uncostedItems: [] }; custMap.set(ck, cust); rep.customers.push(cust); }

      const sale = Number(line.Amount ?? 0);
      // Quantity drives cost (unitCost × qty). If a line carries no Qty but has a
      // unit price, derive it from amount ÷ unit price so cost isn't multiplied
      // by zero (which would make gross profit equal the whole sale).
      const unitPrice = Number(d.UnitPrice ?? 0);
      let qty = Number(d.Qty ?? 0);
      if (!(qty > 0) && unitPrice > 0 && sale > 0) qty = sale / unitPrice;
      const fuel = isFuelLine(name);
      const itemId = d.ItemRef?.value || '';
      // Fuel: cost at the rack price for the invoice date. Everything else uses
      // the QB item PurchaseCost, falling back to the app's maintained inventory
      // cost — matched by item id (bridged through name/SKU) and then by the
      // line name — so profit isn't overstated as the full sale when QB's live
      // PurchaseCost is blank.
      const invCostFor = () =>
        invCostById.get(itemId) ??
        invCostByName.get(name.trim().toLowerCase()) ??
        invCostByName.get(bare(name)) ??
        0;
      let unitCost = costById.get(itemId) ?? 0;
      if (fuel) {
        const product = fuelProductOf(name);
        const rackC = product ? rackCostPerGal(product, inv.TxnDate) : null;
        if (rackC != null) unitCost = rackC;
        // Rack price unavailable → fall back to the maintained inventory cost so a
        // missing rack row doesn't count the whole fuel sale as profit.
        else if (!unitCost) unitCost = invCostFor();
      } else if (!unitCost) {
        unitCost = invCostFor();
      }
      const cost = unitCost * qty;
      const profit = sale - cost;
      // Flag ANY sale (fuel or not) that found no cost — these inflate
      // profit/commission and point at items missing a cost (or fuel missing a
      // rack price). Without surfacing fuel here, a missing rack price silently
      // counted the whole fuel sale as profit.
      if (unitCost === 0 && sale > 0) {
        cust.uncostedSale += sale;
        const label = ((fuel ? 'Fuel (no rack price): ' : '') + (name || 'Unnamed item')).trim();
        if (cust.uncostedItems.length < 8 && !cust.uncostedItems.includes(label)) cust.uncostedItems.push(label);
      }

      let commission: number;
      if (fuel && fuelMode === 'per_gallon') commission = perGal * qty;
      else commission = (pct / 100) * profit;

      cust.sale += sale; cust.profit += profit; cust.commission += commission;
      if (fuel) cust.gallons += qty;
      rep.totalSale += sale; rep.totalProfit += profit; rep.totalCommission += commission;
    }
  }

  // Round + sort.
  const salesmen = Array.from(reps.values()).map((r) => ({
    ...r,
    totalSale: round2(r.totalSale), totalProfit: round2(r.totalProfit), totalCommission: round2(r.totalCommission),
    customers: r.customers
      .map((c) => ({ ...c, sale: round2(c.sale), profit: round2(c.profit), gallons: round2(c.gallons), commission: round2(c.commission), uncostedSale: round2(c.uncostedSale) }))
      .sort((a, b) => b.commission - a.commission),
  })).sort((a, b) => b.totalCommission - a.totalCommission);

  return { salesmen, invoices: invoices.length };
}
