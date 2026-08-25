'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { createClient } from '@/lib/supabase-browser';

// On-screen signature for a haul ticket. Used twice: the driver signs their
// own ticket, and the job foreman signs it off at the end of the day — the two
// signatures at the foot of the paper ticket.
//
// The drawn signature is saved as a PNG in the work-tickets bucket and the
// ticket keeps its path.

const BUCKET = 'work-tickets';

export default function TicketSignature({
  path,
  onChange,
  readOnly = false,
  label = 'Signature',
  hint,
}: {
  path: string | null;
  onChange?: (path: string | null) => void;
  readOnly?: boolean;
  label?: string;
  hint?: string;
}) {
  const supabase = createClient();
  const sigRef = useRef<SignatureCanvas>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadPreview = useCallback(async (p: string | null) => {
    if (!p) { setUrl(null); return; }
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 600);
    setUrl(data?.signedUrl ?? null);
  }, [supabase]);

  useEffect(() => { loadPreview(path); }, [path, loadPreview]);

  async function save() {
    const pad = sigRef.current;
    if (!pad || pad.isEmpty()) { setError('Sign in the box first.'); return; }
    setBusy(true); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You are signed out — sign in again.');
      const dataUrl = pad.getCanvas().toDataURL('image/png');
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const key = `${user.id}/${Date.now()}-signature.png`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(key, bytes, { contentType: 'image/png', upsert: false });
      if (upErr) throw upErr;
      onChange?.(key);
      await loadPreview(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the signature');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {path && !readOnly && (
          <button
            type="button"
            onClick={() => { onChange?.(null); setUrl(null); }}
            className="text-[11px] text-red-600 hover:underline"
          >
            Clear saved
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}

      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Signature" className="mt-2 max-h-28 w-auto rounded border border-gray-200 bg-white" />
      ) : readOnly ? (
        <p className="text-xs text-gray-400 mt-2">Not signed.</p>
      ) : (
        <>
          <p className="text-[11px] text-gray-500 mt-0.5 mb-2">Have the FSR sign here.</p>
          <div className="border-2 border-dashed border-gray-300 rounded-md">
            <SignatureCanvas ref={sigRef} canvasProps={{ width: 400, height: 160, className: 'w-full bg-white rounded-md' }} />
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button type="button" onClick={() => sigRef.current?.clear()} className="text-xs text-gray-500 hover:text-gray-700">
              Clear
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
            >
              {busy ? 'Saving…' : 'Save signature'}
            </button>
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
