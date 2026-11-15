'use client';
import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { maybeCompressImage } from '@/lib/image-compress';
import type { ScanKind } from '@/lib/scan';

// One tap: photograph the paperwork, have it read, fill the form. With
// uploadFolder set, the same photo is also saved to storage (it IS the
// receipt) and the path handed back, so one picture does both jobs.

const BUCKET = 'work-tickets';

export type ScanFields = Record<string, string | number | null>;

export default function ScanFill({
  kind,
  label,
  uploadFolder,
  onFields,
  onUploaded,
}: {
  kind: ScanKind;
  label: string;
  // e.g. 'fleet' — stores the photo at "<uid>/fleet/…" alongside the scan.
  uploadFolder?: string;
  onFields: (fields: ScanFields) => void;
  onUploaded?: (path: string) => void;
}) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handle(file: File) {
    setBusy(true); setError(''); setDone(false);
    try {
      if (!file.type.startsWith('image/')) {
        throw new Error("Take a photo — a PDF can be attached, but can't auto-fill.");
      }
      const small = await maybeCompressImage(file);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Could not read the photo.'));
        r.readAsDataURL(small);
      });
      const base64 = dataUrl.split(',')[1] || '';

      // The read and the upload don't wait on each other.
      const scanPromise = fetch('/api/fleet/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, image: base64, media_type: small.type || 'image/jpeg' }),
      }).then((r) => r.json());

      let uploadPromise: Promise<string | null> = Promise.resolve(null);
      if (uploadFolder) {
        uploadPromise = (async () => {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return null;
          const ext = (small.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
          const key = `${user.id}/${uploadFolder}/${Date.now()}-${kind}.${ext}`;
          const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, small, { upsert: false });
          return upErr ? null : key;
        })();
      }

      const [scan, path] = await Promise.all([scanPromise, uploadPromise]);
      if (path && onUploaded) onUploaded(path);
      if (!scan.ok) throw new Error(scan.error || 'Could not read that photo.');
      onFields(scan.fields as ScanFields);
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that photo.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-brand-300 bg-brand-50 text-brand-700 font-medium hover:bg-brand-100 disabled:opacity-50"
      >
        <span aria-hidden>📷</span>
        {busy ? 'Reading the photo…' : done ? 'Filled in ✓' : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
