'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import type { Hauler } from '@/lib/haulers';
import HaulerDocuments from '@/components/HaulerDocuments';

// The hauling company's own details. These are what land on every haul ticket
// their drivers file, so the company keeps them right rather than asking the
// office to.
//
// Whether they're still hauling for Stallion isn't theirs to set — that flag
// belongs to the office, and the database enforces it.

export default function HaulerCompanyPage() {
  const supabase = createClient();
  const [company, setCompany] = useState<Hauler | null>(null);
  const [form, setForm] = useState<Partial<Hauler>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  // The Auto 1 Funding link — approved (and revocable) on the factoring side.
  const [linkStatus, setLinkStatus] = useState<'none' | 'pending' | 'linked' | 'off' | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState('');

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase
      .from('profiles').select('hauler_id').eq('id', user.id).single();
    if (!profile?.hauler_id) { setLoading(false); return; }
    const { data } = await supabase
      .from('haulers').select('*').eq('id', profile.hauler_id).maybeSingle();
    setCompany((data as Hauler) ?? null);
    setForm((data as Hauler) ?? {});
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/haulers/factoring-link', { cache: 'no-store' });
        const json = await res.json();
        if (json.ok) setLinkStatus(json.status);
      } catch { /* card shows nothing rather than a wrong answer */ }
    })();
  }, []);

  async function requestLink() {
    setLinkBusy(true); setLinkError('');
    try {
      const res = await fetch('/api/haulers/factoring-link', { method: 'POST' });
      const json = await res.json();
      if (!json.ok) { setLinkError(json.error || 'Could not send the request.'); return; }
      setLinkStatus(json.status);
    } catch {
      setLinkError('Network error — try again.');
    } finally {
      setLinkBusy(false);
    }
  }

  async function save() {
    if (!(form.name || '').trim()) { setError('The company needs a name.'); return; }
    if (!company) return;
    setBusy(true); setError(''); setMsg('');
    const { error: err } = await supabase.from('haulers').update({
      name: (form.name || '').trim(),
      contact_name: (form.contact_name || '').trim() || null,
      phone: (form.phone || '').trim() || null,
      email: (form.email || '').trim() || null,
      address: (form.address || '').trim() || null,
      mc_number: (form.mc_number || '').trim() || null,
      dot_number: (form.dot_number || '').trim() || null,
      insurance_expires: form.insurance_expires || null,
    }).eq('id', company.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setMsg('Saved. New tickets will carry these details.');
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const today = new Date().toISOString().slice(0, 10);
  const insuranceExpired = !!company?.insurance_expires && company.insurance_expires < today;

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!company) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
        <h1 className="text-lg font-semibold mb-2">No company on your login yet</h1>
        <p className="text-sm text-gray-600">
          Ask the Stallion office to attach your login to your hauling company.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/hauler" className="text-sm text-brand-700 hover:underline">← Loads</Link>
      <h1 className="text-2xl font-semibold">Company details</h1>
      <p className="text-sm text-gray-600">
        These go on every haul ticket your drivers file, and they&apos;re how
        Stallion&apos;s office reaches you. Keep them current.
      </p>

      {insuranceExpired && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Your insurance expiry date has passed. Update it — Stallion sees this
          against your company.
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="sm:col-span-2"><span className={label}>Business name</span>
            <input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
            <span className="block mt-1 text-[11px] text-gray-500">
              This is the Trucking Company on the haul ticket.
            </span>
          </label>
          <label><span className={label}>Contact name</span>
            <input value={form.contact_name || ''} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className={input} />
          </label>
          <label><span className={label}>Phone</span>
            <input type="tel" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={input} />
          </label>
          <label className="sm:col-span-2"><span className={label}>Email</span>
            <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
          </label>
          <label className="sm:col-span-2"><span className={label}>Address</span>
            <input value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} className={input} />
          </label>
          <label><span className={label}>MC #</span>
            <input value={form.mc_number || ''} onChange={(e) => setForm({ ...form, mc_number: e.target.value })} className={input} />
          </label>
          <label><span className={label}>DOT #</span>
            <input value={form.dot_number || ''} onChange={(e) => setForm({ ...form, dot_number: e.target.value })} className={input} />
          </label>
          <label><span className={label}>Insurance expires</span>
            <input type="date" value={form.insurance_expires || ''} onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })} className={input} />
          </label>
        </div>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
        {msg && <p className="text-sm text-emerald-700 mt-3">{msg}</p>}

        <button
          onClick={save}
          disabled={busy}
          className="mt-3 px-4 py-2 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save details'}
        </button>
      </div>

      {/* Factor Payment is only offered once the factoring app's admin has
          approved this company's Auto 1 Funding account — and they can turn
          it off again over there at any time. */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">
          Auto 1 Funding
        </h2>
        {linkStatus === 'linked' ? (
          <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
            Your Auto 1 Funding account is linked — Factor Payment is available
            on your haul tickets.
          </p>
        ) : linkStatus === 'pending' ? (
          <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Link requested — waiting on Auto 1 Funding&apos;s approval. Factor
            Payment appears on your tickets once they approve it.
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-3">
              {linkStatus === 'off'
                ? 'Your Auto 1 Funding link is currently switched off on their side. You can request it again.'
                : 'Get paid on approved tickets through Auto 1 Funding instead of waiting on the pay run. Linking sends your company details to their team for approval.'}
            </p>
            <button
              onClick={requestLink}
              disabled={linkBusy || linkStatus === null}
              className="px-4 py-2 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
            >
              {linkBusy ? 'Requesting…' : 'Link Auto 1 Funding account'}
            </button>
          </>
        )}
        {linkError && <p className="text-sm text-red-600 mt-2">{linkError}</p>}
      </div>

      <HaulerDocuments haulerId={company.id} canUpload />
    </div>
  );
}
