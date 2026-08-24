'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

// Two-step signup:
//
//  Step 1 — name + email + password + "are you an existing customer?"
//  Step 2 — branched:
//             • new      → business name / phone / address  → creates Business
//             • existing → searches businesses, picks one    → creates pending
//                          business_link_requests row (admin must approve)
//
// We keep all of it on one page so a user can back up. The auth account
// is only created when Step 2 is submitted, so nothing is left orphaned
// if they bail.

type BizMatch = { id: string; name: string; address: string | null };

export default function ShopSignupPage() {
  const router = useRouter();
  const supabase = createClient();

  // Step 1 fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [customerType, setCustomerType] = useState<'new' | 'existing' | null>(null);

  // Step 2 fields — new customer
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [county, setCounty] = useState('');
  const [taxExempt, setTaxExempt] = useState<boolean | null>(null);

  // Step 2 fields — existing customer
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<BizMatch[]>([]);
  const [pickedBusiness, setPickedBusiness] = useState<BizMatch | null>(null);

  // Wizard state
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<'shop' | 'pending' | null>(null);

  function goToStep2() {
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (!customerType) {
      setError('Please tell us if you already have an Auto 1 Oil account.');
      return;
    }
    setStep(2);
  }

  async function doSearch(q: string) {
    setSearchQ(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      // /api/business/search needs the user signed in. Since we haven't
      // created the auth account yet, we need a different path: search
      // first via signed-out RPC... Actually here we have NOT signed up
      // yet, so we have to defer the search until after sign-up — but
      // that creates a UX dead-end. Workaround: sign up immediately on
      // Step 1, THEN allow search. Simpler: use a signed-in temporary
      // account is overkill — instead we'll briefly sign the user in
      // by completing signup first and asking the question after.
      //
      // For now: we sign up, then search. The user perceives it as
      // "creating account → step 2 search". Implementation lives in the
      // submit handler below.
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  // Live search runs against the API once the user has an auth session
  // (post-signup). We delay creating the auth account until Step 2
  // submission so users who bail don't leave orphan accounts. But the
  // existing-customer branch needs to search before final submit. So
  // for the existing-customer branch we sign up at the START of Step 2
  // (when they first arrive on it) and search authenticated.
  // Emulate "no email confirmation": when signup doesn't return a session
  // (Supabase confirmation is enabled), auto-confirm the new customer server-
  // side and sign them in, so they can proceed without a confirmation email.
  async function ensureSession(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    try {
      await fetch('/api/shop/auto-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
    } catch { /* sign-in below surfaces any real failure */ }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return !error;
  }

  async function arriveAtStep2Existing() {
    // Sign up immediately so we have a session for searching.
    setLoading(true);
    setError('');
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: 'customer',
          full_name: contactName,
          phone,
        },
      },
    });
    setLoading(false);
    if (err) {
      setError(err.message);
      setStep(1);
      return;
    }
    if (!data.session) {
      // Auto-confirm + sign in so we can proceed without a confirmation email.
      const ok = await ensureSession(data.user?.id);
      if (!ok) {
        setDone('pending');
        setError('Account created — please sign in to finish linking.');
      }
    }
  }

  async function searchBusinesses() {
    if (searchQ.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/business/search?q=${encodeURIComponent(searchQ)}`);
      const json = await res.json();
      if (json.ok) setResults(json.results as BizMatch[]);
      else setError(json.error || 'Search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function submitNewCustomer(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (!county) {
      setError('Please pick the county where your business is located.');
      setLoading(false);
      return;
    }
    if (taxExempt === null) {
      setError('Please tell us whether your business is sales-tax exempt.');
      setLoading(false);
      return;
    }

    // Sign up first
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: 'customer',
          full_name: contactName,
          business_name: businessName,
          phone,
          address,
        },
      },
    });
    if (err) { setError(err.message); setLoading(false); return; }
    if (!data.session) {
      // Auto-confirm + sign in so checkout setup can continue immediately.
      const ok = await ensureSession(data.user?.id);
      if (!ok) {
        setDone('pending');
        setError('Account created — please sign in to finish setup.');
        setLoading(false);
        return;
      }
    }

    // Create the business and link the new profile as owner
    const { data: biz, error: bizErr } = await supabase
      .from('businesses')
      .insert({
        name: businessName,
        address: address || null,
        phone: phone || null,
        created_by: data.user?.id,
      })
      .select('id')
      .single();
    if (bizErr || !biz) {
      setError(`Account made, but business creation failed: ${bizErr?.message || 'unknown'}`);
      setLoading(false);
      return;
    }
    await supabase
      .from('profiles')
      .update({
        business_id: biz.id,
        is_business_owner: true,
        county,
        // Customers don't have a sales territory — clear the default
        // staff-territory array that the column default would otherwise
        // populate. Keeps the data tidy.
        territory_counties: [],
        // New self-signups must submit their documents before they can check
        // out. W-9 is always required; TC-721 only if they're tax-exempt.
        docs_required: true,
        w9_applicable: true,
        tax_exempt_applicable: taxExempt,
      })
      .eq('id', data.user!.id);

    setDone('shop');
    setLoading(false);
    // Land them on their account so they can submit the required documents.
    router.push('/shop/account?welcome=1');
    router.refresh();
  }

  async function submitExistingCustomer() {
    if (!pickedBusiness) {
      setError('Pick your business from the list.');
      return;
    }
    setLoading(true);
    setError('');
    const res = await fetch('/api/business/request-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: pickedBusiness.id,
        claimed_name: pickedBusiness.name,
        claimed_address: pickedBusiness.address,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      setError(json.error || 'Could not submit link request.');
      setLoading(false);
      return;
    }
    setDone('pending');
    setLoading(false);
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (done === 'shop') {
    return null; // Already pushed to /shop.
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50 py-8">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/auto1-logo.png"
            alt="Auto 1 Oil"
            className="h-16 w-auto mx-auto mb-3"
          />
          <p className="text-sm text-gray-500">
            {step === 1 ? 'Create your account' : customerType === 'existing' ? 'Find your business' : 'Tell us about your business'}
          </p>
        </div>

        {done === 'pending' && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
            <h3 className="font-semibold text-amber-900 text-sm mb-1">
              {customerType === 'existing' ? 'Link request sent' : 'Account created'}
            </h3>
            <p className="text-xs text-amber-900">
              {customerType === 'existing'
                ? 'An admin will review your request and approve the link. Once approved you can place orders against your existing account.'
                : 'Check your email to confirm your address, then sign in.'}
            </p>
            <Link href="/shop/login" className="inline-block mt-3 text-xs font-medium text-brand-700 hover:underline">
              Go to sign in →
            </Link>
          </div>
        )}

        {!done && step === 1 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goToStep2();
              if (customerType === 'existing') arriveAtStep2Existing();
            }}
            className="space-y-3"
          >
            <div>
              <label className="block text-sm font-medium mb-1">Your name</label>
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                required
                autoComplete="name"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder="e.g. 801-555-1234"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div className="pt-2">
              <label className="block text-sm font-medium mb-2">
                Are you already an Auto 1 Oil customer?
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCustomerType('new')}
                  className={`px-3 py-2 text-sm border rounded-md text-center ${
                    customerType === 'new'
                      ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  No, I&apos;m new
                </button>
                <button
                  type="button"
                  onClick={() => setCustomerType('existing')}
                  className={`px-3 py-2 text-sm border rounded-md text-center ${
                    customerType === 'existing'
                      ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Yes, link my account
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {customerType === 'existing'
                  ? "We'll search by business name. An admin will approve the link."
                  : customerType === 'new'
                  ? "Next we'll set up your business info."
                  : ''}
              </p>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading || !customerType}
              className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              {loading ? 'Working…' : 'Continue →'}
            </button>
          </form>
        )}

        {!done && step === 2 && customerType === 'new' && (
          <form onSubmit={submitNewCustomer} className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Business name</label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                placeholder="e.g. Joe's Garage"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Delivery address</label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={2}
                autoComplete="street-address"
                placeholder="Street, city, state, zip"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">County where your business is located</label>
              <select
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
              >
                <option value="">— Pick your county —</option>
                <option value="Utah County">Utah County</option>
                <option value="Salt Lake County">Salt Lake County</option>
                <option value="Davis County">Davis County</option>
                <option value="Weber County">Weber County</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                We use this to route your account to the right sales rep.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">
                Is your business sales-tax exempt?
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTaxExempt(false)}
                  className={`px-3 py-2 text-sm border rounded-md text-center ${
                    taxExempt === false
                      ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  No
                </button>
                <button
                  type="button"
                  onClick={() => setTaxExempt(true)}
                  className={`px-3 py-2 text-sm border rounded-md text-center ${
                    taxExempt === true
                      ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  Yes
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                After you create your account you&apos;ll submit your{' '}
                <span className="font-medium">customer profile sheet</span> and{' '}
                <span className="font-medium">W-9</span>
                {taxExempt ? <>, plus a <span className="font-medium">TC-721</span> tax-exempt form</> : null}.
                These are required before you can place an order.
              </p>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
              >
                {loading ? 'Creating account…' : 'Create account'}
              </button>
            </div>
          </form>
        )}

        {!done && step === 2 && customerType === 'existing' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-600">
              Type your business name to find your existing account.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQ}
                onChange={(e) => doSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchBusinesses(); } }}
                placeholder="e.g. Joe's Garage"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                type="button"
                onClick={searchBusinesses}
                disabled={searching || searchQ.trim().length < 2}
                className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50"
              >
                Search
              </button>
            </div>

            {results.length > 0 && (
              <div className="border border-gray-200 rounded-md divide-y divide-gray-100 max-h-64 overflow-y-auto">
                {results.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setPickedBusiness(b)}
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${
                      pickedBusiness?.id === b.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <div className="font-medium text-sm">{b.name}</div>
                    {b.address && <div className="text-xs text-gray-600 mt-0.5">{b.address}</div>}
                  </button>
                ))}
              </div>
            )}

            {searching && <p className="text-xs text-gray-500">Searching…</p>}
            {!searching && searchQ.trim().length >= 2 && results.length === 0 && (
              <p className="text-xs text-gray-500">
                No matches. Try a different spelling, or go back and choose &ldquo;No, I&apos;m new&rdquo;.
              </p>
            )}

            {pickedBusiness && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                <p className="text-xs text-amber-900">
                  You&apos;ll request a link to <strong>{pickedBusiness.name}</strong>. An admin will
                  review and approve before you can place orders.
                </p>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={submitExistingCustomer}
                disabled={loading || !pickedBusiness}
                className="flex-1 py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
              >
                {loading ? 'Sending request…' : 'Request link'}
              </button>
            </div>
          </div>
        )}

        {!done && (
          <p className="text-sm text-center text-gray-600 mt-6">
            Already have an account?{' '}
            <Link href="/shop/login" className="text-brand-700 font-medium hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
