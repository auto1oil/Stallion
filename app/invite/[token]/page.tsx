'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

// /invite/<token>
//
// Two flows on this page:
//   1) Invitee has no account yet → sign up form, then auto-accept invite.
//   2) Invitee already signed in  → tap "Accept invite" button.
//
// The invite token is non-guessable (24 random bytes base64url), so the
// page itself doesn't need a separate gate.

type Invite = {
  invite_id: string;
  business_id: string;
  business_name: string;
  business_address: string | null;
  role_label: string;
  expires_at: string;
  accepted_at: string | null;
};

export default function InviteRedeemPage() {
  const supabase = createClient();
  const router = useRouter();
  const params = useParams();
  const token = params?.token as string;

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Signup fields (only used if no account yet)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setSignedIn(!!user);
      const { data, error } = await supabase.rpc('get_invite_by_token', { t: token });
      if (error) {
        setError(error.message);
      } else if (!data || data.length === 0) {
        setError('Invite not found.');
      } else {
        setInvite(data[0] as Invite);
      }
      setLoading(false);
    })();
  }, [token]);

  async function acceptAsSignedIn() {
    setBusy(true);
    setError('');
    const { data, error } = await supabase.rpc('accept_invite', { t: token });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    const json = data as { ok: boolean; error?: string };
    if (!json.ok) {
      setError(json.error || 'Could not accept invite.');
      return;
    }
    router.push('/shop');
    router.refresh();
  }

  async function signUpAndAccept(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: 'customer',
          full_name: name,
          phone,
        },
      },
    });
    if (error) { setError(error.message); setBusy(false); return; }
    if (!data.session) {
      setError('Account created. Confirm your email and come back to this link to finish joining.');
      setBusy(false);
      return;
    }
    // Now redeem the invite under the new session.
    const { data: rpcData, error: rpcErr } = await supabase.rpc('accept_invite', { t: token });
    setBusy(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    const json = rpcData as { ok: boolean; error?: string };
    if (!json.ok) { setError(json.error || 'Could not accept invite.'); return; }
    router.push('/shop');
    router.refresh();
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  if (!invite) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
        <div className="bg-white border border-red-200 rounded-lg p-6 max-w-sm w-full">
          <h1 className="font-semibold text-red-800 mb-1">Invite not found</h1>
          <p className="text-sm text-gray-600">{error || 'This invite link is invalid.'}</p>
        </div>
      </div>
    );
  }

  if (invite.accepted_at) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
        <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-sm w-full">
          <h1 className="font-semibold mb-1">Invite already used</h1>
          <p className="text-sm text-gray-600">Ask the business owner to send a new invite.</p>
          <Link href="/shop/login" className="inline-block mt-3 text-sm text-brand-700 hover:underline">Sign in →</Link>
        </div>
      </div>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
        <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-sm w-full">
          <h1 className="font-semibold mb-1">Invite expired</h1>
          <p className="text-sm text-gray-600">Ask the business owner to send a new invite.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50 py-8">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8">
        <div className="text-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/stallion-logo.svg" alt="Stallion" className="h-16 w-auto mx-auto mb-3" />
          <p className="text-sm text-gray-500">You&apos;ve been invited to join</p>
          <h1 className="text-xl font-semibold mt-1">{invite.business_name}</h1>
          {invite.business_address && (
            <p className="text-xs text-gray-500 mt-0.5">{invite.business_address}</p>
          )}
          <p className="text-xs text-gray-500 mt-2">Role: <span className="font-medium">{invite.role_label}</span></p>
        </div>

        {signedIn ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              You&apos;re signed in. Tap below to join {invite.business_name}.
            </p>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={acceptAsSignedIn}
              disabled={busy}
              className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              {busy ? 'Working…' : `Join ${invite.business_name}`}
            </button>
          </div>
        ) : (
          <form onSubmit={signUpAndAccept} className="space-y-3">
            <p className="text-sm text-gray-600">Create your account to join the team.</p>
            <div>
              <label className="block text-sm font-medium mb-1">Your name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name"
                     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
                     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel"
                     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
                     autoComplete="new-password" placeholder="At least 8 characters"
                     className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy}
                    className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
              {busy ? 'Creating account…' : `Join ${invite.business_name}`}
            </button>
            <p className="text-xs text-center text-gray-500 mt-3">
              Already have an account? <Link href={`/shop/login?next=/invite/${token}`} className="text-brand-700 hover:underline">Sign in instead</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
