'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // The reset email lands here with a recovery token. Exchange it for a
  // session so updateUser can set the new password.
  useEffect(() => {
    (async () => {
      const code = new URLSearchParams(window.location.search).get('code');
      if (code) {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exErr) { setError('This reset link is invalid or has expired.'); return; }
      }
      const { data: { session } } = await supabase.auth.getSession();
      if (session) setReady(true);
      else setError('This reset link is invalid or has expired. Request a new one from the sign-in page.');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords don’t match.'); return; }
    setSaving(true); setError('');
    const { error: upErr } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (upErr) { setError(upErr.message); return; }
    // They just set their own password, so clear any admin-set
    // must_change_password flag to avoid being re-prompted at /account.
    const { data: { user } } = await supabase.auth.getUser();
    if (user) await supabase.from('profiles').update({ must_change_password: false }).eq('id', user.id);
    setDone(true);
    // Route from the root, which sends each role to its own home.
    setTimeout(() => { router.push('/'); router.refresh(); }, 1500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/stallion-logo.svg" alt="Stallion" className="h-16 w-auto mx-auto mb-3" />
          <p className="text-sm text-gray-500">Set a new password</p>
        </div>

        {done ? (
          <p className="text-sm text-green-700 text-center">Password updated. Signing you in…</p>
        ) : !ready ? (
          <p className="text-sm text-gray-600 text-center">
            {error || 'Checking your reset link…'}
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              {saving ? 'Saving…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
