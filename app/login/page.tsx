'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function LoginPage() {
  const router = useRouter();
  // Landing chooser vs. the staff sign-in form. Customers are sent to the
  // customer portal's own login; staff sign in right here.
  const [mode, setMode] = useState<'choose' | 'staff' | 'forgot'>('choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  const [resetMsg, setResetMsg] = useState('');

  // Email a password-reset link. Lands on /shop/reset-password (already an
  // allowed redirect), which routes the user back to their dashboard by role
  // after they set a new password. If their email doesn't arrive, an admin can
  // reset it from the Users page instead.
  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(''); setResetMsg('');
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/shop/reset-password`,
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setResetMsg('Check your email for a link to reset your password. If it doesn’t arrive, ask an admin to reset it for you.');
  }

  // Let staff share the app with a customer — native share sheet on
  // phones, clipboard fallback on desktop. Shares the customer signup link.
  async function shareApp() {
    const url = typeof window !== 'undefined'
      ? `${window.location.origin}/shop/signup`
      : 'https://app.auto1oil.com/shop/signup';
    const data = {
      title: 'Auto 1 Oil',
      text: 'Order fuel & oil and track deliveries with Auto 1 Oil. Sign up here:',
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
      } else {
        await navigator.clipboard.writeText(url);
        setShareMsg('Link copied to clipboard');
        setTimeout(() => setShareMsg(''), 2500);
      }
    } catch {
      /* user cancelled the share sheet — ignore */
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push('/');
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/auto1-logo.png"
            alt="Auto 1 Oil"
            className="h-16 w-auto mx-auto mb-3"
          />
          <p className="text-sm text-gray-500">
            {mode === 'choose' ? 'Auto 1 Oil' : mode === 'forgot' ? 'Reset password' : 'Staff sign in'}
          </p>
        </div>

        {mode === 'choose' ? (
          <div className="space-y-3">
            <Link
              href="/shop/login"
              className="block w-full py-3 bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium text-center"
            >
              Customer login
            </Link>
            <button
              type="button"
              onClick={() => setMode('staff')}
              className="block w-full py-3 border border-brand-700 text-brand-700 rounded-md hover:bg-brand-50 font-medium text-center"
            >
              Staff login
            </button>
            <p className="text-xs text-center text-gray-400 pt-1">
              Customers shop and track orders. Staff manage dispatch &amp; delivery.
            </p>
            <div className="pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={shareApp}
                className="w-full py-2.5 flex items-center justify-center gap-2 text-sm text-brand-700 hover:bg-brand-50 rounded-md font-medium"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                Share the app with a customer
              </button>
              {shareMsg && <p className="text-xs text-center text-emerald-600">{shareMsg}</p>}
            </div>
          </div>
        ) : mode === 'staff' ? (
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => { setMode('forgot'); setError(''); setResetMsg(''); }}
            className="block w-full text-xs text-center text-brand-700 hover:underline"
          >
            Forgot your password?
          </button>
          <button
            type="button"
            onClick={() => { setMode('choose'); setError(''); }}
            className="block w-full text-xs text-center text-gray-400 hover:underline"
          >
            ← Back
          </button>
        </form>
        ) : mode === 'forgot' ? (
        <form onSubmit={handleReset} className="space-y-4">
          <p className="text-xs text-gray-500">
            Enter your email and we’ll send you a link to reset your password.
          </p>
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          {resetMsg && <p className="text-sm text-green-700">{resetMsg}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
          >
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
          <button
            type="button"
            onClick={() => { setMode('staff'); setError(''); setResetMsg(''); }}
            className="block w-full text-xs text-center text-gray-500 hover:underline"
          >
            ← Back to sign in
          </button>
        </form>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}
