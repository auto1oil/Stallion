'use client';

// Persistent "you owe receipts" banner for drivers. Shows on every driver page
// whenever the signed-in user has card charges with no matching receipt. It
// cannot be dismissed — it stays until the count hits zero. Each charge can be
// opened to attach a photo + details right here; that marks it 'submitted' so
// an admin can hand it to OneGloveBox. (Receipts uploaded to OneGloveBox
// directly still match and clear on their own.)

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type MissingCharge = { id: string; merchant: string | null; amount: number | null; charge_date: string | null };

export default function MissingReceiptsBanner() {
  const supabase = createClient();
  const [charges, setCharges] = useState<MissingCharge[]>([]);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState<MissingCharge | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setReady(true); return; }
    const { data } = await supabase
      .from('card_charges')
      .select('id, merchant, amount, charge_date')
      .eq('driver_id', user.id)
      .eq('receipt_status', 'missing')
      .order('charge_date', { ascending: false });
    setCharges((data as MissingCharge[]) || []);
    setReady(true);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  // Nothing owed (or not loaded yet) → render nothing.
  if (!ready || charges.length === 0) return null;

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const total = charges.reduce((s, c) => s + (c.amount || 0), 0);
  const n = charges.length;

  return (
    <div className="bg-red-600 text-white">
      <div className="max-w-5xl mx-auto px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-sm sm:text-base">
              ⚠️ Avoid check deductions — upload your receipts
            </div>
            <div className="text-xs sm:text-sm opacity-90 mt-0.5">
              {n} charge{n === 1 ? '' : 's'} still {n === 1 ? 'needs' : 'need'} a receipt · {money(total)}.
              Tap a charge to add a photo + details, or upload to <span className="font-semibold">OneGloveBox</span>.
            </div>
          </div>
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 text-xs font-semibold bg-white/15 hover:bg-white/25 rounded-md px-2.5 py-1.5 whitespace-nowrap">
            {open ? 'Reduce notices' : 'See list'}
          </button>
        </div>

        {open && (
          <div className="mt-2 rounded-md bg-white/10 divide-y divide-white/15 max-h-72 overflow-y-auto">
            {charges.map((c) => (
              <button key={c.id} onClick={() => setActive(c)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-white/10">
                <div className="min-w-0">
                  <div className="truncate">{c.merchant || '(no merchant)'}</div>
                  <div className="text-xs opacity-80">{c.charge_date || 'no date'}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-semibold tabular-nums">{money(c.amount)}</span>
                  <span className="text-[11px] font-semibold bg-white/20 rounded px-1.5 py-0.5">Add receipt</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {active && (
        <ReceiptModal
          charge={active}
          onClose={() => setActive(null)}
          onDone={(id) => { setActive(null); setCharges((prev) => prev.filter((c) => c.id !== id)); }}
        />
      )}
    </div>
  );
}

function ReceiptModal({ charge, onClose, onDone }: {
  charge: MissingCharge;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [vendor, setVendor] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);

  // Show a fit-to-view preview of the chosen photo (revoke the blob URL on swap).
  useEffect(() => {
    if (file && file.type.startsWith('image/')) {
      const u = URL.createObjectURL(file);
      setPreviewUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setPreviewUrl(null);
  }, [file]);

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  async function submit() {
    if (!file) { setError('Add a photo of the receipt.'); return; }
    if (!vendor.trim()) { setError('Add the vendor (who you paid).'); return; }
    if (!note.trim()) { setError('Add an explanation so we know how to expense it.'); return; }
    setSaving(true); setError('');
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${charge.id}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from('card-receipts').upload(path, file);
      if (up.error) throw up.error;
      const { error: updErr } = await supabase.from('card_charges').update({
        receipt_status: 'submitted',
        receipt_source: 'upload',
        receipt_url: up.data.path,
        receipt_vendor: vendor.trim(),
        receipt_note: note.trim() || null,
        receipt_submitted_at: new Date().toISOString(),
      }).eq('id', charge.id);
      if (updErr) throw updErr;
      // Auto-forward to OneGloveBox (no-ops if OGB ingest isn't configured — then
      // it stays in the admin Submitted queue). Either way the driver is done.
      try {
        await fetch('/api/card-charges/push-to-ogb', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chargeId: charge.id }),
        });
      } catch { /* best-effort; admin can still hand it off manually */ }
      onDone(charge.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit the receipt.');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 text-gray-900">
      <div className="bg-white rounded-lg max-w-sm w-full p-5 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-1">Add a receipt</h2>
        <p className="text-sm text-gray-500 mb-3">
          {charge.merchant || '(no merchant)'} · {charge.charge_date || 'no date'} · <span className="font-medium">{money(charge.amount)}</span>
        </p>

        <label className="block text-sm font-medium text-gray-700 mb-1">Photo of the receipt</label>
        {/* No `capture` attribute — forcing the camera drops the file in the
            installed PWA; the native menu (Take Photo / Library) is reliable. */}
        <input type="file" accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="w-full mb-1 text-sm" />
        {file && <p className="text-xs text-emerald-700 mb-2 truncate">Attached: {file.name}</p>}
        {previewUrl && (
          <button type="button" onClick={() => setZoomOpen(true)} className="block w-full mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Receipt preview" className="max-h-48 mx-auto rounded border border-gray-200 object-contain cursor-zoom-in" />
            <span className="block text-[11px] text-gray-400 mt-1">Tap to zoom</span>
          </button>
        )}

        <label className="block text-sm font-medium text-gray-700 mb-1 mt-2">Vendor <span className="text-red-600">(required)</span></label>
        <input value={vendor} onChange={(e) => setVendor(e.target.value)}
          placeholder="Who did you pay? e.g. Autozone, Maverik, Tractor Supply"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3" />

        <label className="block text-sm font-medium text-gray-700 mb-1 mt-2">Explanation <span className="text-red-600">(required)</span></label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="What was this for, so we know where to expense it? e.g. Fuel for truck 12, oil filter, shop supplies…"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3" />

        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
          <button onClick={submit} disabled={saving || !file || !vendor.trim() || !note.trim()}
            className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
            {saving ? 'Submitting…' : 'Submit receipt'}
          </button>
        </div>
      </div>

      {/* Full-screen zoom of the photo they're about to submit. */}
      {zoomOpen && previewUrl && (
        <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-2" onClick={() => setZoomOpen(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Receipt" className="max-w-full max-h-full object-contain" />
          <button onClick={() => setZoomOpen(false)} className="absolute top-4 right-5 text-white text-3xl leading-none">×</button>
        </div>
      )}
    </div>
  );
}
