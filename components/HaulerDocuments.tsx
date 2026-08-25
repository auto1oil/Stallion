'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  HAULER_DOC_BUCKET, HAULER_DOC_KINDS, REQUIRED_DOC_KINDS,
  docStatus, isExpired, isExpiringSoon, type HaulerDocument,
} from '@/lib/hauler-docs';

// A hauling company's paperwork. The same component on both sides: the company
// uploads here, Stallion's office reads the identical list on the hauler's
// page, so there is no "did you send it" — either it's on file or it isn't.
//
// Files go into a private bucket under "<hauler_id>/…", which is what the
// storage policy scopes reads by. Downloads use short-lived signed URLs; the
// bucket is never public.

export default function HaulerDocuments({
  haulerId,
  canUpload,
}: {
  haulerId: string;
  canUpload: boolean;
}) {
  const supabase = createClient();
  const [docs, setDocs] = useState<HaulerDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [kind, setKind] = useState(HAULER_DOC_KINDS[0]);
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('hauler_documents').select('*')
      .eq('hauler_id', haulerId)
      .order('created_at', { ascending: false });
    setDocs((data as HaulerDocument[]) || []);
    setLoading(false);
  }, [supabase, haulerId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function upload(file: File) {
    setBusy('upload'); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You are signed out — sign in again.');

      // The folder is the hauler id because that is what the storage policy
      // reads to decide who may see the file.
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const key = `${haulerId}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage
        .from(HAULER_DOC_BUCKET)
        .upload(key, file, { contentType: file.type || 'application/octet-stream' });
      if (upErr) throw upErr;

      const { error: rowErr } = await supabase.from('hauler_documents').insert({
        hauler_id: haulerId,
        kind,
        file_name: file.name,
        file_path: key,
        expires_on: expiresOn || null,
        notes: notes.trim() || null,
        uploaded_by: user.id,
      });
      if (rowErr) throw rowErr;

      setExpiresOn(''); setNotes('');
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    } catch (e) {
      setError((e as Error).message || 'Could not upload that.');
    } finally {
      setBusy('');
    }
  }

  // The bucket is private, so a link has to be minted each time rather than
  // stored — a stored URL would either expire or be a way around the policy.
  async function open(d: HaulerDocument) {
    setBusy(d.id); setError('');
    const { data, error: err } = await supabase.storage
      .from(HAULER_DOC_BUCKET).createSignedUrl(d.file_path, 300);
    setBusy('');
    if (err || !data?.signedUrl) { setError('Could not open that file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function remove(d: HaulerDocument) {
    setBusy(d.id); setError('');
    // The row goes first: a row pointing at a missing file is worse than a
    // file with no row, which is just unreferenced bytes.
    const { error: rowErr } = await supabase.from('hauler_documents').delete().eq('id', d.id);
    if (rowErr) { setBusy(''); setError(rowErr.message); return; }
    await supabase.storage.from(HAULER_DOC_BUCKET).remove([d.file_path]);
    setBusy('');
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const status = docStatus(docs);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">
        Documents
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        {canUpload
          ? `Stallion needs a current ${REQUIRED_DOC_KINDS.join(' and ')} on file before you run loads.`
          : 'What this company has on file. They upload these themselves.'}
      </p>

      {!loading && !status.ok && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {status.missingKinds.length > 0 && (
            <div>Missing or expired: <strong>{status.missingKinds.join(', ')}</strong></div>
          )}
          {status.expired.length > 0 && (
            <div>{status.expired.length} document{status.expired.length === 1 ? '' : 's'} past their expiry date.</div>
          )}
        </div>
      )}
      {!loading && status.ok && status.expiringSoon.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {status.expiringSoon.length} document{status.expiringSoon.length === 1 ? '' : 's'} expiring within 30 days.
        </div>
      )}

      {canUpload && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label><span className={label}>What is it</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
                {HAULER_DOC_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label><span className={label}>Expires (if it does)</span>
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={input} />
            </label>
            <label><span className={label}>Note</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} />
            </label>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*"
            disabled={busy === 'upload'}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
            className="mt-3 block w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand-700 file:text-white file:font-medium file:text-sm"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            {busy === 'upload' ? 'Uploading…' : 'PDF or a photo. Picking a file uploads it.'}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-gray-500">
          {canUpload ? 'Nothing uploaded yet.' : 'Nothing on file for this company yet.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {docs.map((d) => {
            const expired = isExpired(d);
            const soon = isExpiringSoon(d);
            return (
              <div key={d.id} className="flex justify-between items-start gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className="font-medium">{d.kind}</span>
                  <span className="text-gray-500"> · {d.file_name || 'file'}</span>
                  {d.expires_on && (
                    <span className={
                      expired ? 'text-red-600 font-medium'
                      : soon ? 'text-amber-700 font-medium'
                      : 'text-gray-500'
                    }>
                      {' '}· {expired ? 'expired' : 'expires'} {d.expires_on}
                    </span>
                  )}
                  {d.notes && <span className="block text-xs text-gray-500">{d.notes}</span>}
                </span>
                <span className="flex gap-3 shrink-0">
                  <button onClick={() => open(d)} disabled={busy === d.id}
                    className="text-xs text-brand-700 hover:underline disabled:opacity-50">
                    {busy === d.id ? 'Opening…' : 'Open'}
                  </button>
                  {canUpload && (
                    <button onClick={() => remove(d)} disabled={busy === d.id}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50">
                      Delete
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
