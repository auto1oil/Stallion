'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { createClient } from '@/lib/supabase-browser';

// On-screen signature for a haul ticket. Used twice: the driver signs their
// own ticket, and the job foreman signs it off at the end of the day — the two
// signatures at the foot of the paper ticket.
//
// A drawn squiggle alone doesn't say whose hand it was, so the signer also
// types their name, and the moment of saving is stamped. Name, drawn image
// and timestamp travel together: saved together, cleared together.

const BUCKET = 'work-tickets';

export default function TicketSignature({
  path,
  signerName = null,
  signedAt = null,
  onChange,
  onSigned,
  readOnly = false,
  label = 'Signature',
  hint,
}: {
  path: string | null;
  signerName?: string | null;
  signedAt?: string | null;
  onChange?: (path: string | null) => void;
  // Fires with the typed name and the stamp the moment a signature saves,
  // and with nulls when it's cleared.
  onSigned?: (name: string | null, at: string | null) => void;
  readOnly?: boolean;
  label?: string;
  hint?: string;
}) {
  const supabase = createClient();
  const sigRef = useRef<SignatureCanvas>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
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
    if (!name.trim()) { setError('Type your name first.'); return; }
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
      onSigned?.(name.trim(), new Date().toISOString());
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
            onClick={() => { onChange?.(null); onSigned?.(null, null); setUrl(null); setName(''); }}
            className="text-[11px] text-red-600 hover:underline"
          >
            Clear saved
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}

      {url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Signature" className="mt-2 max-h-28 w-auto rounded border border-gray-200 bg-white" />
          {(signerName || signedAt) && (
            <p className="text-xs text-gray-600 mt-1">
              Signed{signerName ? <> by <strong>{signerName}</strong></> : null}
              {signedAt ? ` · ${new Date(signedAt).toLocaleString()}` : ''}
            </p>
          )}
        </>
      ) : readOnly ? (
        <p className="text-xs text-gray-400 mt-2">Not signed.</p>
      ) : (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type your name"
            autoComplete="name"
            className="mt-2 mb-2 w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm"
          />
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
          <p className="text-[10px] text-gray-400 mt-1">
            Saving stamps the date and time with the name typed above.
          </p>
        </>
      )}
    </div>
  );
}
