'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

// Everyone who uses this app is staff — crew, office, contractors, the funder,
// admins — so there's one sign-in form, plus the forgot-password path.

const EMAIL_KEY = 'stallion-login-email';

// Supabase's raw errors read like log lines. Everyone signs in daily on a
// phone, often with autofill in the way, so the two failures people actually
// hit get said in plain words — and a dead connection stops masquerading as
// a wrong password.
function friendlyAuthError(msg: string): string {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login credentials')) {
    return "That email and password don't match. If your phone filled the password in for you, tap the eye and check what it actually typed.";
  }
  if (m.includes('load failed') || m.includes('failed to fetch') || m.includes('network') || m.includes('fetch')) {
    return "Couldn't reach the server — that's a connection problem, not a wrong password. Check your signal and try again.";
  }
  if (m.includes('email not confirmed')) {
    return "This account isn't finished being set up — ask an admin to confirm it.";
  }
  return msg;
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

  // Sessions don't persist by design, so people type this daily — remember
  // the email (never the password) on the device.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(EMAIL_KEY);
      if (saved) setEmail(saved);
    } catch { /* private mode */ }
  }, []);

  // Email a password-reset link. It lands on /reset-password, which sets the
  // new password and drops them at their own home screen. If the email never
  // arrives, an admin can reset it from the Users page instead.
  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(''); setResetMsg('');
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) { setError(friendlyAuthError(error.message)); return; }
    setResetMsg('Check your email for a link to reset your password. If it doesn’t arrive, ask an admin to reset it for you.');
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(friendlyAuthError(error.message));
      setLoading(false);
    } else {
      try { localStorage.setItem(EMAIL_KEY, email); } catch { /* private mode */ }
      // Record the sign-in before moving on — identity comes from the fresh
      // session cookie, and a failure here never blocks the login itself.
      await fetch('/api/auth/login-event', { method: 'POST', keepalive: true }).catch(() => null);
      router.push('/');
      router.refresh();
    }
  }

  const input = 'w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500';

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/stallion-logo.png"
            alt="Stallion Tank"
            className="h-16 w-auto mx-auto mb-3"
          />
          <p className="text-sm text-gray-500">
            {mode === 'forgot' ? 'Reset password' : 'Sign in'}
          </p>
        </div>

        {mode === 'signin' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={input}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className={`${input} pr-11`}
                />
                {/* The eye: see exactly what was typed (or what autofill put
                    there) before blaming the password. */}
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-700"
                >
                  {showPw ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
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
          </form>
        ) : (
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
                className={input}
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
              onClick={() => { setMode('signin'); setError(''); setResetMsg(''); }}
              className="block w-full text-xs text-center text-gray-500 hover:underline"
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
