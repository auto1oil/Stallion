'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import ReceiptCapture from '@/components/ReceiptCapture';
import { CHARGE_TYPES, chargeTypeLabel, RECEIPT_BUCKET, type Charge } from '@/lib/charges';

// Record a fuel or misc charge in the field. The receipt photo is required —
// Save stays disabled until the scan has actually uploaded, so a charge can't
// go in without its picture (and the picture can't silently fail to save).

const today = () => new Date().toISOString().slice(0, 10);

export default function ChargesPage() {
  const supabase = createClient();
  const [mine, setMine] = useState<Charge[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [myName, setMyName] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [type, setType] = useState<'fuel' | 'misc'>('fuel');
  const [amount, setAmount] = useState('');
  const [chargedOn, setChargedOn] = useState(today());
  const [vendor, setVendor] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptPath, setReceiptPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setMeId(user.id);
    const { data: me } = await supabase
      .from('profiles').select('full_name, email').eq('id', user.id).single();
    setMyName(me?.full_name || me?.email || '');
    const { data } = await supabase
      .from('charges').select('*')
      .eq('created_by', user.id)
      .order('charged_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(100);
    setMine((data as Charge[]) || []);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function save() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError('Enter the amount.'); return; }
    if (!receiptPath) { setError('Scan the receipt first — the charge doesn’t go in without it.'); return; }
    if (!meId) { setError('You are signed out — sign in again.'); return; }
    setBusy(true); setError(''); setMsg('');
    const { error: err } = await supabase.from('charges').insert({
      created_by: meId,
      spent_by_name: myName || null,
      charged_on: chargedOn || today(),
      type,
      amount: Math.round(amt * 100) / 100,
      vendor: vendor.trim() || null,
      unit_number: unitNumber.trim() || null,
      job_number: jobNumber.trim() || null,
      notes: notes.trim() || null,
      receipt_path: receiptPath,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setMsg('Charge recorded — receipt saved with it.');
    setAmount(''); setVendor(''); setNotes(''); setReceiptPath(null);
    refresh();
  }

  async function remove(c: Charge) {
    if (!window.confirm(`Delete this $${Number(c.amount).toFixed(2)} ${chargeTypeLabel(c.type)} charge?`)) return;
    const { error: err } = await supabase.from('charges').delete().eq('id', c.id);
    if (err) { setError(err.message); return; }
    await supabase.storage.from(RECEIPT_BUCKET).remove([c.receipt_path]).catch(() => null);
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
      <h1 className="text-2xl font-semibold">Charges</h1>
      <p className="text-sm text-gray-600">
        Fuel or supplies bought on the company — scan the receipt and it saves
        with the charge. No receipt, no charge.
      </p>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {CHARGE_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setType(t.value)}
              className={`px-3 py-2.5 rounded-md border text-sm font-medium ${
                type === t.value
                  ? 'border-brand-700 bg-brand-700 text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>Amount ($)</span>
            <input type="number" step="0.01" min="0" inputMode="decimal"
              value={amount} onChange={(e) => setAmount(e.target.value)} className={input} />
          </label>
          <label><span className={label}>Date</span>
            <input type="date" value={chargedOn} onChange={(e) => setChargedOn(e.target.value)} className={input} />
          </label>
          <label><span className={label}>Where (station / store)</span>
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} className={input} />
          </label>
          <label><span className={label}>Unit #</span>
            <input value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} className={input} />
          </label>
          <label><span className={label}>Job # (if it belongs to one)</span>
            <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} className={input} />
          </label>
          <label><span className={label}>Note</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} />
          </label>
        </div>

        <ReceiptCapture path={receiptPath} onChange={setReceiptPath} />

        {error && <p className="text-sm text-red-600">{error}</p>}
        {msg && <p className="text-sm text-emerald-700">{msg}</p>}

        <button
          onClick={save}
          disabled={busy || !receiptPath}
          className="w-full py-2.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
        >
          {busy ? 'Saving…' : receiptPath ? 'Save charge' : 'Scan the receipt to save'}
        </button>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
          My charges
        </h2>
        {mine === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing recorded yet.</p>
        ) : (
          <div className="space-y-1.5">
            {mine.map((c) => (
              <div key={c.id} className="bg-white border border-gray-200 rounded-lg px-3 py-2 flex justify-between items-center gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">${Number(c.amount).toFixed(2)}</span>
                  <span className="text-gray-500">
                    {' '}· {chargeTypeLabel(c.type)} · {c.charged_on}
                    {c.vendor ? ` · ${c.vendor}` : ''}
                    {c.unit_number ? ` · Unit ${c.unit_number}` : ''}
                  </span>
                </span>
                <span className="flex gap-3 shrink-0 items-center">
                  <OpenReceipt path={c.receipt_path} />
                  <button onClick={() => remove(c)} className="text-xs text-red-600 hover:underline">
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// A tap-time signed link, tab first — Safari-safe, never a stale URL.
function OpenReceipt({ path }: { path: string }) {
  const supabase = createClient();
  async function open() {
    const tab = window.open('about:blank', '_blank');
    const { data } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 300);
    if (!data?.signedUrl) { tab?.close(); return; }
    if (tab) tab.location.href = data.signedUrl; else window.location.href = data.signedUrl;
  }
  return (
    <button onClick={open} className="text-xs text-brand-700 hover:underline">
      Receipt
    </button>
  );
}
