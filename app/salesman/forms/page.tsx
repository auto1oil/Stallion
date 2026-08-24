'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type AssignedBiz = { id: string; name: string };

const DOC_TYPES = [
  { key: 'profile_sheet', label: 'Customer Profile', templateUrl: '/forms/customer-profile.pdf' },
  { key: 'tax_exempt',    label: 'Sales Tax-Exempt (TC-721)', templateUrl: '/forms/tc-721-sales-tax-exempt.pdf' },
  { key: 'fein',          label: 'W-9 / FEIN', templateUrl: '/forms/w-9.pdf' },
] as const;

export default function SalesmanFormsPage() {
  const supabase = createClient();
  const [customers, setCustomers] = useState<AssignedBiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadFor, setUploadFor] = useState<Record<string, string>>({}); // doc_type -> business_id
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data } = await supabase
        .from('businesses')
        .select('id, name')
        .eq('assigned_sales_rep_id', user.id)
        .order('name');
      setCustomers((data as AssignedBiz[]) || []);
      setLoading(false);
    })();
  }, []);

  async function uploadDoc(docType: string, file: File) {
    const businessId = uploadFor[docType];
    if (!businessId) {
      setUploadMsg((m) => ({ ...m, [docType]: 'Pick a customer first.' }));
      return;
    }
    setUploading(docType);
    setUploadMsg((m) => ({ ...m, [docType]: '' }));
    const form = new FormData();
    form.append('business_id', businessId);
    form.append('doc_type', docType);
    form.append('file', file);
    const res = await fetch('/api/rep/upload-customer-doc', { method: 'POST', body: form });
    const json = await res.json();
    setUploading(null);
    if (json.ok) {
      setUploadMsg((m) => ({ ...m, [docType]: 'Uploaded ✓' }));
      setTimeout(() => setUploadMsg((m) => ({ ...m, [docType]: '' })), 2000);
    } else {
      setUploadMsg((m) => ({ ...m, [docType]: json.error || 'Upload failed' }));
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">Forms</h1>
      <p className="text-sm text-gray-500 mb-4">
        Download a blank template, gather the customer's signature, then upload the
        filled-in copy to their account.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          {DOC_TYPES.map((d) => (
            <div key={d.key} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex justify-between items-center gap-2 flex-wrap mb-3">
                <h2 className="font-semibold">{d.label}</h2>
                <a
                  href={d.templateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-brand-700 hover:underline"
                >
                  Download blank template ↓
                </a>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={uploadFor[d.key] || ''}
                  onChange={(e) => setUploadFor((u) => ({ ...u, [d.key]: e.target.value }))}
                  className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white max-w-[240px]"
                  disabled={customers.length === 0}
                >
                  <option value="">
                    {customers.length === 0 ? 'No assigned customers' : 'Pick customer…'}
                  </option>
                  {customers.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <label
                  className={`px-3 py-1.5 border rounded text-sm cursor-pointer ${
                    uploadFor[d.key]
                      ? 'border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100'
                      : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {uploading === d.key ? 'Uploading…' : 'Upload filled copy'}
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    disabled={!uploadFor[d.key] || uploading === d.key}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadDoc(d.key, f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {uploadMsg[d.key] && (
                  <span
                    className={`text-sm ${
                      uploadMsg[d.key] === 'Uploaded ✓' ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {uploadMsg[d.key]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
