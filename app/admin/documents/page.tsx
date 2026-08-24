'use client';

// Admin "Documents" tab — the company document library: upload proof of
// insurance, sales-tax cert, W-9, etc. and send them out (download or copy a
// 7-day share link). Stored via /api/admin/company-docs (service-role;
// auto-created private bucket). Blank fillable forms live on the Forms tab.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type Doc = { path: string; name: string; category: string; size: number | null; created_at: string | null; url: string | null };

const UPLOAD_CATEGORIES = ['Proof of insurance', 'Sales tax', 'W-9', 'Licenses', 'Filled forms', 'Other'];

function fmtSize(n: number | null) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminDocumentsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [upName, setUpName] = useState('');
  const [upCat, setUpCat] = useState('Proof of insurance');
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const res = await fetch('/api/admin/company-docs');
      const j = await res.json();
      if (res.status === 403) { setAllowed(false); return; }
      setAllowed(true);
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not load documents.'); return; }
      setDocs(j.docs as Doc[]);
    } catch {
      setErr('Could not load documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return; }
      load();
    });
  }, [supabase, router, load]);

  async function upload(file: File) {
    setUploading(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', upName.trim() || file.name);
      fd.append('category', upCat || 'Other');
      const res = await fetch('/api/admin/company-docs', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Upload failed.'); return; }
      setUpName('');
      load();
    } finally {
      setUploading(false);
    }
  }

  async function remove(path: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch('/api/admin/company-docs', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    load();
  }

  async function copyLink(d: Doc) {
    if (!d.url) return;
    try { await navigator.clipboard.writeText(d.url); setCopied(d.path); setTimeout(() => setCopied(null), 2000); } catch { /* ignore */ }
  }

  if (allowed === false) return <p className="text-sm text-gray-500">Documents are for admins only.</p>;

  const byCat = docs.reduce((acc, d) => { (acc[d.category] ||= []).push(d); return acc; }, {} as Record<string, Doc[]>);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-1">Documents</h1>
      <p className="text-sm text-gray-500 mb-4">
        Store important documents (proof of insurance, sales-tax cert, W-9) and send them out.
        Fill out a blank form for a specific customer below.
      </p>

      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      {/* Upload */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-2">Add a document</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-gray-600 flex flex-col flex-1 min-w-[150px]">Name (optional)
            <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="e.g. 2026 Certificate of Insurance"
              className="mt-1 px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </label>
          <label className="text-xs text-gray-600 flex flex-col min-w-[150px]">Category
            <select value={upCat} onChange={(e) => setUpCat(e.target.value)}
              className="mt-1 px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              {UPLOAD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className={`px-3 py-2 text-sm rounded-md font-medium cursor-pointer ${uploading ? 'bg-gray-100 text-gray-400' : 'bg-brand-700 text-white hover:bg-brand-900'}`}>
            {uploading ? 'Uploading…' : 'Choose file'}
            <input type="file" accept="application/pdf,image/*,.doc,.docx,.heic" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {/* Library */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-gray-500 mb-6">No documents yet — add one above.</p>
      ) : (
        <div className="space-y-4 mb-6">
          {Object.entries(byCat).map(([cat, list]) => (
            <div key={cat}>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{cat}</div>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {list.map((d) => (
                  <div key={d.path} className="px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-medium break-words">{d.name}</div>
                      <div className="text-xs text-gray-400">
                        {fmtSize(d.size)}{d.created_at ? ` · ${new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-sm">
                      {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">Download</a>}
                      {d.url && <button onClick={() => copyLink(d)} className="text-brand-700 hover:underline">{copied === d.path ? 'Copied!' : 'Copy link'}</button>}
                      <button onClick={() => remove(d.path, d.name)} className="text-red-600 hover:underline">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400">
        Need a blank fillable form (customer profile, sales tax, W-9)? They&apos;re on the Forms tab —
        filled copies save back here under “Filled forms”.
      </p>
    </div>
  );
}
