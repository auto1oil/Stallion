'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { type CartItem, CONTAINER_SIZES, brandFor, sizeLabel } from '@/lib/cart';
import CustomItemButton from '@/components/CustomItemButton';

// Fuel loads pull from one of two terminal racks and bill against a fuel
// account. Captured per fuel line so the office knows where to load and who
// to bill. Only shown for products in the "Fuel" category.
// "Inventory" = fuel pulled from our own warehouse stock (no terminal rack,
// no supplier account). Kept first so it's the top option.
const LOADING_RACKS = ['Inventory', 'Pioneer', 'Woodscross'] as const;
const FUEL_ACCOUNTS = ['Auto 1 Oil', 'Brad Hall', 'Little America', 'Sinclair', 'Other'] as const;
const isFuelProduct = (category: string) => category.trim().toLowerCase() === 'fuel';

type Customer = {
  id: string;
  full_name: string | null;
  business_name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
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

type InvItem = {
  id: string;
  description: string | null;
  qb_name: string;
  packaging: string | null;
  retail_price: number | null;
  match_product_id: string | null;
  match_weight: string | null;
  match_container_size: string | null;
};

type Me = { id: string; full_name: string | null; email: string; role: string };

type Term = { id: string; name: string; dueDays: number | null };

export default function SalesmanPlaceOrderPage() {
  const supabase = createClient();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Matched inventory retail prices (no cost), keyed product|weight|size.
  const [retail, setRetail] = useState<Map<string, number>>(new Map());
  // Full active inventory for the "All items" ordering list.
  const [inventory, setInventory] = useState<InvItem[]>([]);
  const [listTab, setListTab] = useState<'quick' | 'all'>('quick');
  const [invSearch, setInvSearch] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [picker, setPicker] = useState<Product | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [chargeTax, setChargeTax] = useState(false); // default: no sales tax (most customers exempt)
  // Payment terms for this order. '' = Auto (fuel→Net 10, else customer default).
  const [terms, setTerms] = useState<Term[]>([]);
  const [termId, setTermId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push('/login'); return; }

    const [meRes, custRes, prodRes, invRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, role').eq('id', user.id).single(),
      supabase
        .from('profiles')
        .select('id, full_name, business_name, email, phone, address')
        .eq('role', 'customer')
        .order('business_name', { ascending: true, nullsFirst: false })
        .order('email'),
      supabase
        .from('products')
        .select('id, name, category, sort_order, container_sizes, weights, sizes_by_weight, variant_label, default_weight, default_container_size')
        .eq('active', true)
        .order('sort_order'),
      // Active inventory items — retail only (never cost). Loaded via the
      // service-role staff endpoint (NOT a direct table read) so every staff
      // role, including drivers, gets the full list: the inventory_items RLS
      // read policy only covers salesman/admin, so a direct query returns
      // nothing for a driver and the "All items" list comes up empty.
      fetch('/api/staff/inventory')
        .then((r) => r.json())
        .then((j) => (j?.ok ? { data: j.items as InvItem[] } : { data: [] as InvItem[] }))
        .catch(() => ({ data: [] as InvItem[] })),
    ]);
    setMe(meRes.data as Me);
    const custList = (custRes.data as Customer[]) || [];
    setCustomers(custList);
    // Opened from a customer card (?customer=<profile id>, or ?q=<name>): jump
    // straight to that customer so the rep can put the order in.
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const preId = params.get('customer');
      const preQ = params.get('q');
      const found = preId ? custList.find((c) => c.id === preId) : null;
      if (found) setSelected(found);
      else if (preQ) setSearch(preQ);
    }
    setProducts((prodRes.data as Product[]) || []);
    const invRows = (invRes.data as InvItem[]) || [];
    setInventory(invRows);
    const rp = new Map<string, number>();
    invRows.forEach((r) => {
      if (r.retail_price != null && r.match_product_id) {
        rp.set(`${r.match_product_id}|${r.match_weight || ''}|${r.match_container_size || ''}`, r.retail_price);
      }
    });
    setRetail(rp);
    setLoading(false);

    // QuickBooks terms for the payment-terms dropdown (non-blocking).
    fetch('/api/quickbooks/terms')
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setTerms(j.terms as Term[]); })
      .catch(() => {});
  }

  useEffect(() => { load(); }, []);

  function pickCustomer(c: Customer) {
    setSelected(c);
    setDeliveryAddress(c.address || '');
    setOrderNotes('');
    setPoNumber('');
    setChargeTax(false);
    setTermId('');
    setCart([]);
    setError('');
  }

  function unpickCustomer() {
    if (cart.length > 0 && !confirm('Discard the cart and pick a different customer?')) return;
    setSelected(null);
    setCart([]);
    setSearch('');
  }

  const isAdmin = me?.role === 'admin' || me?.role === 'master_admin';
  // Matched retail price for a cart line (admin's default starting price).
  function retailFor(item: CartItem): number | null {
    return retail.get(`${item.product_id || ''}|${item.weight || ''}|${item.container_size || ''}`) ?? null;
  }

  function addToCart(item: CartItem) {
    const idx = cart.findIndex((c) =>
      c.product_id === item.product_id
      && c.container_size === item.container_size
      && c.brand === item.brand
      && c.weight === item.weight
      // Fuel lines with a different rack/account stay separate.
      && (c.loading_rack ?? null) === (item.loading_rack ?? null)
      && (c.fuel_account ?? null) === (item.fuel_account ?? null),
    );
    let next: CartItem[];
    if (idx >= 0) {
      next = [...cart];
      next[idx] = { ...next[idx], quantity: next[idx].quantity + item.quantity };
    } else {
      // Admins start each line at the matched retail price (editable below);
      // fuel/unmatched lines stay null so they price automatically.
      next = [...cart, { ...item, unit_price: isAdmin ? retailFor(item) : null }];
    }
    setCart(next);
    setPicker(null);
  }

  function removeItem(i: number) { setCart(cart.filter((_, idx) => idx !== i)); }
  function changeQty(i: number, qty: number) {
    if (qty < 1) return;
    const next = [...cart];
    next[i] = { ...next[i], quantity: qty };
    setCart(next);
  }
  function changePrice(i: number, priceStr: string) {
    const next = [...cart];
    const v = priceStr.trim() === '' ? null : Number(priceStr);
    next[i] = { ...next[i], unit_price: v != null && Number.isFinite(v) && v >= 0 ? v : null };
    setCart(next);
  }

  async function submit() {
    if (!me || !selected) return;
    if (cart.length === 0) { setError('Cart is empty.'); return; }
    if (!deliveryAddress.trim()) { setError('Delivery address required.'); return; }

    setSubmitting(true); setError('');
    const { data: order, error: orderErr } = await supabase
      .from('customer_orders')
      .insert({
        customer_id: selected.id,
        sales_rep_id: me.id,        // the sales rep is also automatically the rep
        submitted_by_id: me.id,     // sales-rep-submitted (≠ customer_id)
        delivery_address: deliveryAddress.trim(),
        notes: orderNotes.trim() || null,
        po_number: poNumber.trim() || null,
        charge_tax: chargeTax,
        payment_term_id: termId || null,
        payment_term_name: termId ? (terms.find((t) => t.id === termId)?.name ?? null) : null,
      })
      .select('id')
      .single();
    if (orderErr || !order) {
      setError(orderErr?.message || 'Could not create order.');
      setSubmitting(false);
      return;
    }

    const { error: itemsErr } = await supabase
      .from('customer_order_items')
      .insert(cart.map((c) => ({
        customer_order_id: order.id,
        product_id: c.product_id,
        product_name: c.product_name,
        container_size: c.container_size,
        brand: c.brand,
        weight: c.weight,
        quantity: c.quantity,
        notes: c.notes || null,
        unit_price: c.unit_price ?? null,
      })));
    if (itemsErr) {
      setError(`Order created but items failed: ${itemsErr.message}. Tell admin to check #${order.id.slice(0, 8)}.`);
      setSubmitting(false);
      return;
    }

    // Fuel orders auto-spawn a purchase order (rack + account + gallons, price
    // blank) for the buyer to reconcile against the supplier's bill. Fire-and-
    // forget: the order is already saved, so a failure here never blocks it.
    try {
      await fetch('/api/fuel-po/create-from-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_order_id: order.id }),
      });
    } catch {
      // ignore — PO creation is best-effort
    }

    // For auto-invoice customers this skips approval: invoice in QB + push to
    // the warehouse. Non-flagged customers (or any QB failure) just stay
    // pending for normal admin approval — so we never block the placer on it.
    let posted = false;
    let autoReason: string | null = null;
    let autoFlagged = false;
    try {
      const res = await fetch('/api/orders/auto-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_order_id: order.id }),
      });
      const json = await res.json();
      posted = !!json?.posted;
      autoFlagged = !!json?.flagged;
      autoReason = json?.qb_error || json?.reason || null;
    } catch {
      // ignore — order is already saved as pending
    }

    // If this customer is set to skip approval but the order DIDN'T auto-post,
    // don't silently drop it into the approval queue with no explanation —
    // show why (QuickBooks error, etc.) so it can be reported/fixed. The order
    // is already saved as pending, so an admin can still approve it.
    if (!posted && autoFlagged) {
      setSubmitting(false);
      setError(
        `This order was saved but did NOT auto-post to the warehouse: ${autoReason || 'unknown reason'}. ` +
        `It's waiting on the approval page. Order #${order.id.slice(0, 8)}.`,
      );
      return;
    }

    // Done. Admins/master admins go back to the Orders board (where the order
    // now sits — auto-posted to Warehouse, or Pending if not auto-invoiced);
    // salesmen/drivers return to their dashboard with the success flag.
    const isAdmin = me.role === 'admin' || me.role === 'master_admin';
    router.push(
      isAdmin
        ? '/admin'
        : `/salesman?orderPlacedFor=${encodeURIComponent(selected.business_name || selected.email)}&orderId=${order.id}${posted ? '&posted=1' : ''}`,
    );
  }

  // Filter — tokenized so "Denny's in Riverton" matches a customer named
  // "Denny's" whose address contains "Riverton". Apostrophes (straight or
  // curly) are stripped, and common filler words are ignored, so each
  // remaining word just has to appear somewhere in the customer's details.
  const STOP_WORDS = new Set(['in', 'at', 'the', 'of', 'and']);
  const normalize = (s: string) => s.toLowerCase().replace(/['’]/g, '');
  const filteredCustomers = customers.filter((c) => {
    const q = normalize(search.trim());
    if (!q) return true;
    const hay = normalize(
      [c.business_name, c.full_name, c.email, c.phone, c.address].filter(Boolean).join(' '),
    );
    const tokens = q.split(/\s+/).filter((t) => t && !STOP_WORDS.has(t));
    if (tokens.length === 0) return true;
    return tokens.every((t) => hay.includes(t));
  });

  // Group products
  const grouped: Record<string, Product[]> = {};
  const categoryOrder: string[] = [];
  products.forEach((p) => {
    if (!(p.category in grouped)) {
      grouped[p.category] = [];
      categoryOrder.push(p.category);
    }
    grouped[p.category].push(p);
  });

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  // ── STATE 1: customer not picked yet ─────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <h1 className="text-2xl font-semibold mb-1">Place order for a customer</h1>
        <p className="text-sm text-gray-500 mb-4">
          Hi {me?.full_name || me?.email}. Pick the customer you're ordering for.
        </p>

        <input
          type="text"
          placeholder="Search business, name, email, or city…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-base mb-3"
        />

        {filteredCustomers.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-8">
            {search.trim() ? 'No matching customers.' : 'No customer accounts yet.'}
          </p>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {filteredCustomers.map((c) => (
              <button
                key={c.id}
                onClick={() => pickCustomer(c)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 active:bg-gray-100"
              >
                <div className="font-medium text-sm">{c.business_name || c.full_name || c.email}</div>
                <div className="text-xs text-gray-500">
                  {c.full_name && c.business_name ? `${c.full_name} · ` : ''}
                  {c.email}
                  {c.phone ? ` · ${c.phone}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── STATE 2: customer picked, build the order ────────────────────────────
  const totalCartItems = cart.reduce((s, c) => s + c.quantity, 0);

  return (
    <div className="pb-32">
      <div className="flex justify-between items-start mb-1 gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{selected.business_name || selected.full_name || selected.email}</h1>
          <p className="text-xs text-gray-500">
            Placing on behalf · sales rep {me?.full_name || me?.email}
          </p>
        </div>
        <button onClick={unpickCustomer} className="text-sm text-brand-700 hover:underline whitespace-nowrap">
          Switch customer
        </button>
      </div>

      <div className="text-xs text-gray-500 mb-4">
        {selected.email}{selected.phone ? ' · ' + selected.phone : ''}
      </div>

      {/* Two ordering lists: Quick (frequent catalog) and All items (full
          inventory for rarely-ordered products). */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {([
          ['quick', 'Quick list'],
          ['all', `All items (${inventory.length})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setListTab(key)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              listTab === key
                ? 'border-brand-700 text-brand-700 font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {listTab === 'quick' ? (
        <div className="space-y-5 mb-6">
          {categoryOrder.map((cat) => (
            <div key={cat}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{cat}</h2>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {grouped[cat].map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPicker(p)}
                    className="w-full flex justify-between items-center px-4 py-3 hover:bg-gray-50 active:bg-gray-100 text-left"
                  >
                    <span className="text-sm">{p.name}</span>
                    <span className="text-brand-700 font-medium text-sm whitespace-nowrap">+ Add</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Custom item — for anything not in the catalog yet. */}
          <CustomItemButton onAdd={addToCart} />
        </div>
      ) : (
        <div className="mb-6">
          <input
            value={invSearch}
            onChange={(e) => setInvSearch(e.target.value)}
            placeholder="Search all items…"
            className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {inventory
              .filter((it) => {
                const n = invSearch.trim().toLowerCase();
                if (!n) return true;
                return `${it.description || ''} ${it.qb_name} ${it.packaging || ''}`.toLowerCase().includes(n);
              })
              .slice(0, 300)
              .map((it) => (
                <button
                  key={it.id}
                  onClick={() => addToCart({
                    product_id: null,
                    product_name: it.description || it.qb_name,
                    container_size: it.packaging || '—',
                    brand: null,
                    weight: null,
                    quantity: 1,
                    is_custom: true,
                  })}
                  className="w-full flex justify-between items-center gap-3 px-4 py-2.5 hover:bg-gray-50 active:bg-gray-100 text-left"
                >
                  <span className="min-w-0">
                    <span className="text-sm block truncate">{it.description || it.qb_name}</span>
                    <span className="text-xs text-gray-500">
                      {it.packaging || '—'}{it.retail_price != null ? ` · $${it.retail_price.toFixed(2)}` : ''}
                    </span>
                  </span>
                  <span className="text-brand-700 font-medium text-sm whitespace-nowrap shrink-0">+ Add</span>
                </button>
              ))}
            {inventory.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-gray-400">No inventory items yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Cart + checkout */}
      {totalCartItems > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Cart · {totalCartItems} item{totalCartItems === 1 ? '' : 's'}
          </h2>
          <div className="divide-y divide-gray-100 mb-3">
            {cart.map((item, i) => (
              <div key={i} className="px-1 py-2 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{item.product_name}{item.weight ? ' ' + item.weight : ''}</div>
                  <div className="text-xs text-gray-500">{item.container_size}</div>
                  {(item.loading_rack || item.fuel_account) && (
                    <div className="text-[11px] text-gray-400">
                      {item.loading_rack ? `Rack: ${item.loading_rack}` : ''}
                      {item.loading_rack && item.fuel_account ? ' · ' : ''}
                      {item.fuel_account ? `Acct: ${item.fuel_account}` : ''}
                    </div>
                  )}
                </div>
                <input
                  type="number" min={1} value={item.quantity}
                  onChange={(e) => changeQty(i, parseInt(e.target.value || '0', 10))}
                  className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-md text-center"
                />
                {isAdmin && (
                  <span className="flex items-center text-sm text-gray-500">
                    $
                    <input
                      type="number" min={0} step="0.01"
                      value={item.unit_price ?? ''}
                      onChange={(e) => changePrice(i, e.target.value)}
                      placeholder="auto"
                      title="Price each — leave blank to auto-price (fuel rack / retail)"
                      className="w-20 ml-0.5 px-2 py-1 text-sm border border-gray-300 rounded-md text-right"
                    />
                  </span>
                )}
                <button onClick={() => removeItem(i)} className="text-red-600 text-xs px-1 hover:text-red-800">
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="space-y-3 mt-4 border-t border-gray-200 pt-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Delivery address</label>
              <textarea
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                rows={2}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base resize-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                PO number <span className="text-gray-400 font-normal">(only if the customer requires one)</span>
              </label>
              <input
                type="text"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="Customer's PO #"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={chargeTax}
                  onChange={(e) => setChargeTax(e.target.checked)}
                  className="w-4 h-4"
                />
                Charge sales tax
                <span className="text-gray-400 font-normal text-xs">(off = tax-exempt; most customers)</span>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Notes <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                rows={2}
                placeholder="Anything the office should know — preferred date, special handling, etc."
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base resize-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Payment terms</label>
              <select
                value={termId}
                onChange={(e) => setTermId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base bg-white"
              >
                <option value="">Auto — customer default (fuel always Net 10)</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                Leave on Auto to use the customer's saved QuickBooks terms. Fuel orders bill Net 10 regardless.
              </p>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

          <button
            onClick={submit}
            disabled={submitting}
            className="w-full mt-4 py-3 bg-brand-700 text-white font-semibold rounded-md hover:bg-brand-900 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit order for ' + (selected.business_name || selected.full_name || selected.email)}
          </button>
        </div>
      )}

      {/* Add-to-cart dialog */}
      {picker && (
        <AddProductDialog product={picker} retail={retail} onCancel={() => setPicker(null)} onAdd={addToCart} />
      )}

      <Link href="/salesman" className="text-sm text-gray-500 hover:text-gray-900 mt-4 inline-block">
        ← Back to dashboard
      </Link>
    </div>
  );
}

function AddProductDialog({ product, retail, onAdd, onCancel }: {
  product: Product;
  retail: Map<string, number>;
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

  // Fuel-only: loading rack + fuel account (required before a fuel line can be
  // added). Non-fuel products skip these entirely.
  const isFuel = isFuelProduct(product.category);
  const [loadingRack, setLoadingRack] = useState<string>('');
  const [fuelAccount, setFuelAccount] = useState<string>('');
  const [fuelAccountOther, setFuelAccountOther] = useState<string>('');
  const resolvedAccount = fuelAccount === 'Other' ? fuelAccountOther.trim() : fuelAccount;
  // Warehouse "Inventory" pulls have no supplier account, so the fuel account
  // is N/A and not required to move forward.
  const isInventory = loadingRack === 'Inventory';
  const fuelReady = !isFuel || (!!loadingRack && (isInventory || !!resolvedAccount));

  function onWeightChange(newWeight: string) {
    setWeight(newWeight);
    const next = sizesForWeight(newWeight);
    if (!next.includes(size)) setSize(next[0]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = parseInt(qty, 10);
    if (!q || q < 1) return;
    if (isFuel && !fuelReady) return;
    onAdd({
      product_id: product.id,
      product_name: product.name,
      container_size: size,
      brand: brandFor(size),
      weight: hasWeights ? weight : null,
      quantity: q,
      loading_rack: isFuel ? loadingRack : null,
      fuel_account: isFuel ? (isInventory ? 'N/A' : resolvedAccount) : null,
      notes: isFuel ? `Loading rack: ${loadingRack} · Fuel account: ${isInventory ? 'N/A' : resolvedAccount}` : undefined,
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
          {isFuel && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Loading rack</label>
                <select
                  value={loadingRack}
                  onChange={(e) => setLoadingRack(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-base bg-white"
                >
                  <option value="">Select a rack…</option>
                  {LOADING_RACKS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${isInventory ? 'text-gray-400' : 'text-gray-700'}`}>
                  Fuel account{isInventory && <span className="ml-1 font-normal">— N/A for Inventory</span>}
                </label>
                <select
                  value={isInventory ? '' : fuelAccount}
                  onChange={(e) => setFuelAccount(e.target.value)}
                  disabled={isInventory}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-base bg-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                >
                  <option value="">{isInventory ? 'N/A — pulled from inventory' : 'Select an account…'}</option>
                  {FUEL_ACCOUNTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                {!isInventory && fuelAccount === 'Other' && (
                  <input
                    type="text"
                    value={fuelAccountOther}
                    onChange={(e) => setFuelAccountOther(e.target.value)}
                    placeholder="Type the fuel account"
                    className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md text-base"
                  />
                )}
              </div>
            </>
          )}
          {(() => {
            const price = retail.get(`${product.id}|${hasWeights ? weight : ''}|${size}`);
            return price != null ? (
              <div className="text-sm text-gray-700">Retail price: <span className="font-semibold">${price.toFixed(2)}</span> ea</div>
            ) : null;
          })()}
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
            <button type="submit" disabled={isFuel && !fuelReady}
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md font-medium disabled:opacity-50">Add to cart</button>
          </div>
        </form>
      </div>
    </div>
  );
}
