'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { maybeCompressImage } from '@/lib/image-compress';
import { RECEIPT_BUCKET } from '@/lib/charges';

// The receipt scan on a charge. The photo uploads the moment it's taken and
// the component only reports a path AFTER the upload has succeeded — so the
// charge form can hard-require it, and "the scan didn't save" can't happen
// silently: an upload failure is shown in red right under the button, with
// the file picker ready to try again.

export default function ReceiptCapture({
  path,
  onChange,
  readOnly = false,
}: {
  path: string | null;
  onChange: (path: string | null) => void;
  readOnly?: boolean;
}) {
  const supabase = createClient();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const loadPreview = useCallback(async (p: string | null) => {
    if (!p) { setUrl(null); return; }
    const { data } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(p, 600);
    setUrl(data?.signedUrl ?? null);
  }, [supabase]);

  useEffect(() => { loadPreview(path); }, [path, loadPreview]);

  async function upload(file: File) {
    setBusy(true); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You are signed out — sign in again.');
      const small = await maybeCompressImage(file);
      const ext = (small.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const key = `${user.id}/${Date.now()}-receipt.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .upload(key, small, { contentType: small.type || 'image/jpeg' });
      if (upErr) throw upErr;
      // Only now does the form learn a path exists — saved means saved.
      onChange(key);
      await loadPreview(key);
    } catch (err) {
      setError(err instanceof Error
        ? `The scan did not save — ${err.message}. Take it again.`
        : 'The scan did not save. Take it again.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  // Open mints a fresh link at tap time, tab first — Safari rules.
  async function openFresh() {
    if (!path) return;
    const tab = window.open('about:blank', '_blank');
    const { data, error: err } = await supabase.storage
      .from(RECEIPT_BUCKET).createSignedUrl(path, 300);
    if (err || !data?.signedUrl) { tab?.close(); setError('Could not open the receipt.'); return; }
    if (tab) tab.location.href = data.signedUrl; else window.location.href = data.signedUrl;
  }

  const isImage = !!path && !/\.pdf$/i.test(path);

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          Receipt photo <span className="text-red-600">*</span>
        </span>
        {path && !readOnly && (
          <button type="button" onClick={() => { onChange(null); setUrl(null); }}
            className="text-[11px] text-red-600 hover:underline">
            Retake
          </button>
        )}
      </div>

      {path ? (
        isImage && url ? (
          <button type="button" onClick={openFresh} className="block mt-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="Receipt" className="max-h-56 w-auto rounded border border-gray-200" />
          </button>
        ) : (
          <button type="button" onClick={openFresh}
            className="mt-2 inline-block text-sm text-brand-700 hover:underline">
            Open receipt
          </button>
        )
      ) : readOnly ? (
        <p className="text-xs text-gray-400 mt-2">No receipt.</p>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
            className="mt-2 block w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand-700 file:text-white file:text-xs file:font-medium hover:file:bg-brand-900"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            {busy ? 'Saving the scan…' : 'Snap the receipt — it uploads as soon as you take it.'}
          </p>
        </>
      )}
      {path && !busy && (
        <p className="mt-1 text-[11px] text-emerald-700">Scan saved ✓</p>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
