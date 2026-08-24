'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { type CartItem, CONTAINER_SIZES, brandFor, sizeLabel, loadCart, saveCart } from '@/lib/cart';
import CustomItemButton from '@/components/CustomItemButton';

type Product = {
  id: string;
  name: string;
  category: string;
  is_oil: boolean;
  sort_order: number;
  container_sizes: string[] | null;
  weights: string[] | null;
  /** Optional per-weight size restrictions. Falls back to container_sizes if a weight isn't listed here. */
  sizes_by_weight: Record<string, string[]> | null;
  /** Label for the variant dropdown — "Weight" for motor oil, "Color" for coolant, etc. */
  variant_label: string;
  default_weight: string | null;
  default_container_size: string | null;
};

export default function ShopHomePage() {
  const supabase = createClient();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [picker, setPicker] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastOrderItems, setLastOrderItems] = useState<CartItem[] | null>(null);
  const [lastOrderDate, setLastOrderDate] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [productsRes, lastOrderRes] = await Promise.all([
      supabase
        .from('products')
        .select('id, name, category, is_oil, sort_order, container_sizes, weights, sizes_by_weight, variant_label, default_weight, default_container_size')
        .eq('active', true)
        .order('sort_order')
        .order('name'),
      supabase
        .from('customer_orders')
        .select('id, created_at, customer_order_items(product_id, product_name, container_size, quantity)')
        .eq('customer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    setProducts((productsRes.data as Product[]) || []);
    setCart(loadCart());

    const lastOrder = lastOrderRes.data?.[0];
    if (lastOrder && Array.isArray(lastOrder.customer_order_items) && lastOrder.customer_order_items.length > 0) {
      setLastOrderItems(
        lastOrder.customer_order_items.map((it: any) => ({
          product_id: it.product_id,
          product_name: it.product_name,
          container_size: it.container_size,
          brand: it.brand || brandFor(it.container_size),
          weight: it.weight ?? null,
          quantity: it.quantity,
        })),
      );
      setLastOrderDate(lastOrder.created_at || null);
    }

    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function addToCart(item: CartItem) {
    const existing = cart.findIndex(
      (c) => c.product_id === item.product_id
          && c.container_size === item.container_size
          && c.brand === item.brand
          && c.weight === item.weight,
    );
    let next: CartItem[];
    if (existing >= 0) {
      next = [...cart];
      next[existing] = { ...next[existing], quantity: next[existing].quantity + item.quantity };
    } else {
      next = [...cart, item];
    }
    setCart(next);
    saveCart(next);
    setPicker(null);
  }

  function reorderLast() {
    if (!lastOrderItems) return;
    saveCart(lastOrderItems);
    setCart(lastOrderItems);
    router.push('/shop/checkout');
  }

  // Group products by category, preserving sort
  const grouped = products.reduce((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {} as Record<string, Product[]>);
  // Keep category insertion order (which already follows sort_order via the query)
  const categoryOrder: string[] = [];
  products.forEach((p) => {
    if (!categoryOrder.includes(p.category)) categoryOrder.push(p.category);
  });

  const totalCartItems = cart.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <div className="pb-24">
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Order Products</h1>
          <p className="text-sm text-gray-500">Pick what you need and head to checkout. Pricing on your invoice.</p>
        </div>
      </div>

      {lastOrderItems && lastOrderItems.length > 0 && (
        <button
          onClick={reorderLast}
          className="w-full mb-6 py-4 text-base font-semibold bg-brand-700 text-white rounded-xl hover:bg-brand-900 active:bg-brand-900 transition flex items-center justify-center gap-2"
        >
          <span className="text-xl">↺</span>
          Reorder Last Order ({lastOrderItems.length} item{lastOrderItems.length === 1 ? '' : 's'})
          {lastOrderDate && (
            <span className="font-normal text-white/85">
              {' '}placed on{' '}
              {new Date(lastOrderDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
            </span>
          )}
        </button>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading products…</p>
      ) : (
        <div className="space-y-6">
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
      )}

      {picker && (
        <AddProductDialog
          product={picker}
          onCancel={() => setPicker(null)}
          onAdd={addToCart}
        />
      )}

      {/* Sticky checkout bar */}
      {totalCartItems > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-40">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-semibold">{totalCartItems}</span> item{totalCartItems === 1 ? '' : 's'} in cart
            </div>
            <Link
              href="/shop/checkout"
              className="px-5 py-2.5 bg-brand-700 text-white font-semibold rounded-md hover:bg-brand-900"
            >
              Checkout →
            </Link>
          </div>
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

  // Initial weight: product.default_weight if valid, else weights[0]
  const initialWeight = hasWeights
    ? (product.default_weight && weights.includes(product.default_weight) ? product.default_weight : weights[0])
    : '';
  const [weight, setWeight] = useState<string>(initialWeight);

  // Sizes available given the current weight (if the weight has a specific
  // override list, use it; otherwise fall back to the product's defaults).
  const sizesForWeight = (w: string): readonly string[] => {
    if (w && sizesByWeight[w] && sizesByWeight[w].length > 0) return sizesByWeight[w];
    return defaultSizes;
  };
  const currentSizes = sizesForWeight(initialWeight);

  // Initial size: product.default_container_size if valid for current weight,
  // else first size for the current weight.
  const initialSize =
    product.default_container_size && currentSizes.includes(product.default_container_size)
      ? product.default_container_size
      : currentSizes[0];
  const [size, setSize] = useState<string>(initialSize);
  const [qty, setQty] = useState<string>('');

  // If the user changes weight and their currently-selected size isn't valid
  // for the new weight, jump them to the first valid one.
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
                {weights.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
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
              {currentSizes.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              autoFocus
              placeholder="e.g. 4"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
            />
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md font-medium"
            >
              Add to cart
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
