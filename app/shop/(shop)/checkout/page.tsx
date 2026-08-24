'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { type CartItem, clearCart, loadCart, saveCart } from '@/lib/cart';

type SalesRep = { id: string; full_name: string | null; email: string };
type Profile = {
  id: string;
  business_name: string | null;
  full_name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  business_id: string | null;
  docs_required: boolean;
  tax_exempt_applicable: boolean;
  w9_applicable: boolean;
};

export default function CheckoutPage() {
  const supabase = createClient();
  const router = useRouter();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [me, setMe] = useState<Profile | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [selectedRepId, setSelectedRepId] = useState<string>('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [missingDocs, setMissingDocs] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push('/shop/login'); return; }

    const [{ data: profile }, { data: repRows }, { data: docRows }] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, business_name, full_name, email, phone, address, business_id, docs_required, tax_exempt_applicable, w9_applicable')
        .eq('id', user.id)
        .single(),
      supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('role', ['admin', 'master_admin', 'salesman'])
        .order('full_name'),
      supabase
        .from('customer_documents')
        .select('doc_type')
        .eq('customer_id', user.id),
    ]);

    const p = profile as Profile;
    setMe(p);
    setReps((repRows as SalesRep[]) || []);
    setDeliveryAddress(p?.address || '');

    // New self-signup customers must have their required documents on file
    // before checkout. Existing/QB-imported customers (docs_required = false)
    // are never blocked here.
    if (p?.docs_required) {
      const have = new Set(((docRows as { doc_type: string }[]) || []).map((d) => d.doc_type));
      const need: string[] = [];
      if (!have.has('profile_sheet')) need.push('Customer profile sheet');
      if (p.w9_applicable && !have.has('fein')) need.push('W-9');
      if (p.tax_exempt_applicable && !have.has('tax_exempt')) need.push('Tax-exempt form (TC-721)');
      setMissingDocs(need);
    } else {
      setMissingDocs([]);
    }

    setCart(loadCart());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function removeItem(index: number) {
    const next = cart.filter((_, i) => i !== index);
    setCart(next);
    saveCart(next);
  }

  function changeQty(index: number, qty: number) {
    if (qty < 1) return;
    const next = [...cart];
    next[index] = { ...next[index], quantity: qty };
    setCart(next);
    saveCart(next);
  }

  async function submit() {
    if (!me) return;
    if (missingDocs.length > 0) {
      setError('Please submit your required documents before placing an order.');
      return;
    }
    if (!me.business_id) {
      setError('Your account is not linked to a business yet — checkout is locked until an admin approves your account.');
      return;
    }
    if (cart.length === 0) {
      setError('Your cart is empty.');
      return;
    }
    if (!deliveryAddress.trim()) {
      setError('Delivery address is required.');
      return;
    }
    setSubmitting(true);
    setError('');

    const { data: order, error: orderErr } = await supabase
      .from('customer_orders')
      .insert({
        customer_id: me.id,
        sales_rep_id: selectedRepId || null,
        submitted_by_id: me.id,        // customer placed the order themselves
        delivery_address: deliveryAddress.trim(),
        notes: orderNotes.trim() || null,
      })
      .select('id')
      .single();

    if (orderErr || !order) {
      setError(orderErr?.message || 'Could not submit order.');
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
      })));

    if (itemsErr) {
      setError(`Order created but items failed: ${itemsErr.message}. Contact us to confirm.`);
      setSubmitting(false);
      return;
    }

    // If the customer typed a new address, save it as their default
    if (deliveryAddress.trim() && deliveryAddress.trim() !== me.address) {
      await supabase
        .from('profiles')
        .update({ address: deliveryAddress.trim() })
        .eq('id', me.id);
    }

    clearCart();
    router.push(`/shop/order/${order.id}?placed=1`);
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  if (cart.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600 mb-4">Your cart is empty.</p>
        <Link href="/shop" className="text-brand-700 font-medium hover:underline">← Back to shop</Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Checkout</h1>

      {missingDocs.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-amber-900 text-sm mb-1">
            Required documents needed before you can order
          </h3>
          <p className="text-xs text-amber-900">
            Please submit the following on your account page:
          </p>
          <ul className="list-disc list-inside text-xs text-amber-900 mt-1">
            {missingDocs.map((d) => <li key={d}>{d}</li>)}
          </ul>
          <Link
            href="/shop/account?welcome=1"
            className="inline-block mt-3 text-xs font-medium text-brand-700 hover:underline"
          >
            Go to my documents →
          </Link>
        </div>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Cart</h2>
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 mb-6">
        {cart.map((item, i) => (
          <div key={i} className="px-4 py-3 flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">{item.product_name}{item.weight ? ' ' + item.weight : ''}</div>
              <div className="text-xs text-gray-500">{item.container_size}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={1}
                value={item.quantity}
                onChange={(e) => changeQty(i, parseInt(e.target.value || '0', 10))}
                className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-md text-center"
              />
              <button
                onClick={() => removeItem(i)}
                className="text-red-600 text-xs px-1.5 py-1 hover:text-red-800"
                aria-label="Remove"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Order details</h2>
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3 mb-6">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Delivery address</label>
          <textarea
            value={deliveryAddress}
            onChange={(e) => setDeliveryAddress(e.target.value)}
            rows={2}
            required
            placeholder="Street, city, state, zip"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-base resize-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Your sales rep <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <select
            value={selectedRepId}
            onChange={(e) => setSelectedRepId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-base bg-white"
          >
            <option value="">— pick someone, or leave blank —</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.full_name || r.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Notes <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={orderNotes}
            onChange={(e) => setOrderNotes(e.target.value)}
            rows={2}
            placeholder="Special instructions, preferred delivery date, etc."
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-base resize-none"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      <div className="flex justify-between items-center gap-2">
        <Link href="/shop" className="text-sm text-gray-600 hover:text-gray-900">← Keep shopping</Link>
        <button
          onClick={submit}
          disabled={submitting || missingDocs.length > 0}
          title={missingDocs.length > 0 ? 'Submit your required documents first' : undefined}
          className="px-6 py-3 bg-brand-700 text-white font-semibold rounded-md hover:bg-brand-900 disabled:opacity-50"
        >
          {submitting ? 'Placing order…' : 'Place order'}
        </button>
      </div>

      <p className="text-xs text-gray-500 mt-4 text-center">
        We'll create an invoice in QuickBooks and someone will be in touch shortly to confirm pricing and delivery.
      </p>
    </div>
  );
}
