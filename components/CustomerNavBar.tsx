'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { CART_CHANGED_EVENT, type CartItem, loadCart, saveCart } from '@/lib/cart';
import MessageBubble from './MessageBubble';

export default function CustomerNavBar({ email }: { email: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [accountHidden, setAccountHidden] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setUserId(user?.id || null));
    // Master admin can hide "My account" for customers (feature_flags).
    supabase.from('feature_flags').select('enabled').eq('key', 'customer:/shop/account').maybeSingle()
      .then(({ data }) => setAccountHidden((data as { enabled?: boolean } | null)?.enabled === false));
  }, [supabase]);

  // Hydrate the cart from localStorage on mount + on any change
  useEffect(() => {
    const refresh = () => setCart(loadCart());
    refresh();
    window.addEventListener(CART_CHANGED_EVENT, refresh);
    // Also pick up changes from other browser tabs
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function removeItem(i: number) {
    const next = cart.filter((_, idx) => idx !== i);
    saveCart(next);    // saveCart fires CART_CHANGED_EVENT so setCart will update
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push('/shop/login');
    router.refresh();
  }

  const totalItems = cart.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <header className="bg-brand-900 text-white relative sticky top-0 z-40">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
        <Link href="/shop" className="shrink-0 inline-flex items-center" aria-label="Auto 1 Oil — Shop">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/auto1-logo.png"
            alt="Auto 1 Oil"
            className="h-9 w-auto bg-white px-2 py-1 rounded"
          />
        </Link>
        <nav className="flex items-center gap-3 sm:gap-5 text-sm">
          <Link href="/shop" className="hover:underline">Shop</Link>
          {!accountHidden && <Link href="/shop/account" className="hover:underline">My account</Link>}
          {userId && (
            <MessageBubble userId={userId} href="/shop/messages" className="text-white hover:text-accent-300" />
          )}

          {/* Cart icon with quick-look popover */}
          <div className="relative" ref={popoverRef}>
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1 hover:underline focus:outline-none"
              aria-label={`Cart (${totalItems} item${totalItems === 1 ? '' : 's'})`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline-block">
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
              {totalItems > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 text-[10px] font-bold bg-accent-400 text-brand-900 rounded-full">
                  {totalItems}
                </span>
              )}
            </button>

            {open && (
              <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white text-gray-900 rounded-lg shadow-lg border border-gray-200 z-50">
                <div className="p-3 border-b border-gray-100">
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold text-sm">Cart</span>
                    <span className="text-xs text-gray-500">
                      {totalItems} item{totalItems === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
                {cart.length === 0 ? (
                  <div className="p-6 text-center text-sm text-gray-500">
                    Your cart is empty.
                    <div className="mt-3">
                      <Link
                        href="/shop"
                        onClick={() => setOpen(false)}
                        className="inline-block px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900"
                      >
                        Browse products
                      </Link>
                    </div>
                  </div>
                ) : (
                  <>
                    <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
                      {cart.map((item, i) => (
                        <li key={i} className="px-3 py-2 flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium">
                              {item.product_name}{item.weight ? ' ' + item.weight : ''}
                            </div>
                            <div className="text-xs text-gray-500">
                              {item.container_size} · qty {item.quantity}
                            </div>
                          </div>
                          <button
                            onClick={() => removeItem(i)}
                            className="text-xs text-red-600 hover:text-red-800 shrink-0"
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="p-3 border-t border-gray-100 flex gap-2">
                      <Link
                        href="/shop"
                        onClick={() => setOpen(false)}
                        className="flex-1 text-center px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                      >
                        Keep shopping
                      </Link>
                      <Link
                        href="/shop/checkout"
                        onClick={() => setOpen(false)}
                        className="flex-1 text-center px-3 py-2 text-sm bg-brand-700 text-white font-semibold rounded-md hover:bg-brand-900"
                      >
                        Checkout →
                      </Link>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <button onClick={logout} className="hover:underline text-brand-50">
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
