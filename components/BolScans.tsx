'use client';
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { maybeCompressImage } from '@/lib/image-compress';

// The BOL slots on a ticket — scans of the bills of lading for the day's
// loads. Same flow as the paper-ticket photo, but a ticket carries several:
// one BOL per load is a normal day. Files go to the same private bucket,
// under the uploader's own folder so the storage policy works unchanged.

const BUCKET = 'work-tickets';

export default function BolScans({
  paths,
  onChange,
  readOnly = false,
}: {
  paths: string[];
  onChange?: (paths: string[]) => void;
  readOnly?: boolean;
}) {
  const supabase = createClient();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Thumbnails for the image scans; PDFs just get an open button.
  useEffect(() => {
    let stale = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const p of paths) {
        if (/\.pdf$/i.test(p)) continue;
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 600);
        if (data?.signedUrl) out[p] = data.signedUrl;
      }
      if (!stale) setUrls(out);
    })();
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|')]);

  async function upload(files: FileList) {
    setBusy(true); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You are signed out — sign in again.');
      const added: string[] = [];
      for (const file of Array.from(files)) {
        const small = await maybeCompressImage(file);
        const ext = (small.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const key = `${user.id}/${Date.now()}-bol-${added.length}.${ext}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, small, { upsert: false });
        if (upErr) throw upErr;
        added.push(key);
      }
      onChange?.([...paths, ...added]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  // A fresh signed URL at tap time, with the tab opened BEFORE the await —
  // Safari blocks a window.open that comes after one.
  async function openFresh(p: string) {
    const tab = window.open('about:blank', '_blank');
    const { data, error: err } = await supabase.storage.from(BUCKET).createSignedUrl(p, 300);
    if (err || !data?.signedUrl) {
      tab?.close();
      setError('Could not open that scan — try again, or re-attach it.');
      return;
    }
    if (tab) tab.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">BOL scans</span>
        {paths.length > 0 && (
          <span className="text-[11px] text-gray-500">
            {paths.length} attached
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mt-0.5">
        Bills of lading for the day&apos;s loads — scan each one here.
      </p>

      {paths.length === 0 ? (
        <p className="text-xs text-gray-400 mt-2">
          {readOnly ? 'None attached.' : 'Nothing scanned yet.'}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {paths.map((p, i) => (
            <div key={p} className="relative">
              {/\.pdf$/i.test(p) ? (
                <button
                  type="button"
                  onClick={() => openFresh(p)}
                  className="flex h-20 w-20 items-center justify-center rounded border border-gray-200 bg-gray-50 text-xs text-brand-700 hover:underline"
                >
                  BOL {i + 1} (PDF)
                </button>
              ) : (
                <button type="button" onClick={() => openFresh(p)} className="block">
                  {urls[p] ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={urls[p]}
                      alt={`BOL ${i + 1}`}
                      className="h-20 w-20 object-cover rounded border border-gray-200"
                    />
                  ) : (
                    <span className="flex h-20 w-20 items-center justify-center rounded border border-gray-200 bg-gray-50 text-[10px] text-gray-400">
                      Loading…
                    </span>
                  )}
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove BOL ${i + 1}`}
                  onClick={() => onChange?.(paths.filter((x) => x !== p))}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-600 text-white text-[11px] leading-5 text-center shadow"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="mt-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            multiple
            disabled={busy}
            onChange={(e) => { if (e.target.files?.length) upload(e.target.files); }}
            className="block w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand-700 file:text-white file:text-xs file:font-medium hover:file:bg-brand-900"
          />
          {busy && <p className="text-xs text-gray-500 mt-1">Uploading…</p>}
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
