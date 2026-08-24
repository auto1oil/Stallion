'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { maybeCompressImage } from '@/lib/image-compress';

// One attachment slot on a field ticket — the photo of the paper ticket, or the
// short ticket. Same shape as the delivery-photo flow in DeliveryDetail: the
// phone's camera fills the file input, the image is compressed client-side, and
// it uploads straight to the private work-tickets bucket. Files live under
// "<uid>/…" so the storage policy can let a crew member read their own uploads
// back without giving them everyone else's.

const BUCKET = 'work-tickets';

export default function TicketAttachment({
  label,
  hint,
  path,
  onChange,
  readOnly = false,
}: {
  label: string;
  hint?: string;
  path: string | null;
  onChange?: (path: string | null) => void;
  readOnly?: boolean;
}) {
  const supabase = createClient();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const loadPreview = useCallback(async (p: string | null) => {
    if (!p) { setUrl(null); return; }
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 600);
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
      const key = `${user.id}/${Date.now()}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, small, { upsert: false });
      if (upErr) throw upErr;
      onChange?.(key);
      await loadPreview(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const isImage = !!path && !/\.pdf$/i.test(path);

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
            Remove
          </button>
        )}
      </div>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}

      {url ? (
        isImage ? (
          <a href={url} target="_blank" rel="noreferrer" className="block mt-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={label} className="max-h-56 w-auto rounded border border-gray-200" />
          </a>
        ) : (
          <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-brand-700 hover:underline">
            Open {label.toLowerCase()}
          </a>
        )
      ) : (
        <p className="text-xs text-gray-400 mt-2">{readOnly ? 'Not attached.' : 'Nothing attached yet.'}</p>
      )}

      {!readOnly && (
        <div className="mt-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
            className="block w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand-700 file:text-white file:text-xs file:font-medium hover:file:bg-brand-900"
          />
          {busy && <p className="text-xs text-gray-500 mt-1">Uploading…</p>}
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
      )}
    </div>
  );
}
