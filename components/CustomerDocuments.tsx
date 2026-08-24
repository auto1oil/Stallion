'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import FillablePdfForm from './FillablePdfForm';
import { PDF_FORM_CONFIGS } from '@/lib/pdf-forms';

type Doc = {
  id: string;
  doc_type: 'profile_sheet' | 'tax_exempt' | 'fein';
  file_path: string;
  file_name: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  uploaded_at: string;
};

type DocSpec = {
  key: Doc['doc_type'];
  label: string;
  help: string;
  required?: boolean;
  /** URL to a blank PDF the customer can download and fill out before re-uploading. */
  templateUrl?: string;
  templateLabel?: string;
};

const DOC_SPECS: DocSpec[] = [
  {
    key: 'profile_sheet',
    label: 'Customer profile sheet',
    help: 'Required for all new customers. Download the blank form, fill it out, then upload it back.',
    required: true,
    templateUrl: '/forms/customer-profile.pdf',
    templateLabel: 'Download blank profile sheet',
  },
  {
    key: 'tax_exempt',
    label: 'Sales tax-exempt form (Utah TC-721)',
    help: 'Only required if you qualify for tax-free purchases.',
    templateUrl: '/forms/tc-721-sales-tax-exempt.pdf',
    templateLabel: 'Download blank TC-721',
  },
  {
    key: 'fein',
    label: 'W-9 / FEIN',
    help: 'Required for fuel account customers. The W-9 is the standard IRS form for your federal tax ID.',
    templateUrl: '/forms/w-9.pdf',
    templateLabel: 'Download blank W-9',
  },
];

function fmtBytes(n: number | null) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function CustomerDocuments({
  customerId,
  readOnly = false,
  onChanged,
  requiredDocTypes,
}: {
  customerId: string;
  /** When true, hide upload/delete controls. Admin viewing someone else's docs. */
  readOnly?: boolean;
  /** Fired after a successful upload/replace/delete so a parent can refresh
   *  any derived state (e.g. missing-document badges). */
  onChanged?: () => void;
  /** Doc types that are required for this specific customer (in addition to any
   *  marked required by default). Drives the asterisk + Missing/Optional badge. */
  requiredDocTypes?: Doc['doc_type'][];
}) {
  const supabase = createClient();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filling, setFilling] = useState<Doc['doc_type'] | null>(null);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('customer_documents')
      .select('*')
      .eq('customer_id', customerId);
    setDocs((data as Doc[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [customerId]);

  function existing(t: Doc['doc_type']): Doc | undefined {
    return docs.find((d) => d.doc_type === t);
  }

  async function handleUpload(docType: Doc['doc_type'], file: File) {
    setUploading(docType);
    setError('');

    const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
    const path = `${customerId}/${docType}-${Date.now()}${ext ? `.${ext}` : ''}`;

    // If replacing, drop the old file first so we don't bloat storage.
    const prior = existing(docType);
    if (prior) {
      await supabase.storage.from('customer-documents').remove([prior.file_path]);
    }

    const { error: upErr } = await supabase.storage
      .from('customer-documents')
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (upErr) {
      setError(`Upload failed: ${upErr.message}`);
      setUploading(null);
      return;
    }

    const { error: dbErr } = await supabase
      .from('customer_documents')
      .upsert({
        customer_id: customerId,
        doc_type: docType,
        file_path: path,
        file_name: file.name,
        file_size_bytes: file.size,
        mime_type: file.type || null,
        uploaded_at: new Date().toISOString(),
      }, { onConflict: 'customer_id,doc_type' });
    if (dbErr) {
      setError(`Record failed: ${dbErr.message}`);
      setUploading(null);
      return;
    }
    setUploading(null);
    load();
    onChanged?.();
  }

  async function handleDownload(doc: Doc) {
    const { data, error: err } = await supabase.storage
      .from('customer-documents')
      .createSignedUrl(doc.file_path, 60);
    if (err || !data) {
      alert(`Could not generate download link: ${err?.message ?? 'unknown error'}`);
      return;
    }
    window.open(data.signedUrl, '_blank');
  }

  async function handleDelete(doc: Doc) {
    if (!confirm(`Delete ${doc.file_name}?`)) return;
    await supabase.storage.from('customer-documents').remove([doc.file_path]);
    await supabase.from('customer_documents').delete().eq('id', doc.id);
    load();
    onChanged?.();
  }

  if (loading) return <p className="text-sm text-gray-500">Loading documents…</p>;

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}
      {DOC_SPECS.map((spec) => {
        const doc = existing(spec.key);
        const isUploading = uploading === spec.key;
        const isRequired = spec.required || (requiredDocTypes?.includes(spec.key) ?? false);
        return (
          <div key={spec.key} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex justify-between items-start gap-2 flex-wrap mb-1">
              <div>
                <div className="font-medium text-sm">
                  {spec.label}{' '}
                  {isRequired && <span className="text-red-500">*</span>}
                </div>
                <div className="text-xs text-gray-500">{spec.help}</div>
              </div>
              {doc ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-800 border border-green-200">
                  Uploaded
                </span>
              ) : (
                <span className={`text-xs px-2 py-0.5 rounded-full ${isRequired ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
                  {isRequired ? 'Missing' : 'Optional'}
                </span>
              )}
            </div>

            {doc && (
              <div className="mt-2 text-sm flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleDownload(doc)}
                  className="text-brand-700 hover:underline font-medium"
                >
                  📄 {doc.file_name}
                </button>
                <span className="text-xs text-gray-500">
                  {fmtBytes(doc.file_size_bytes)}
                  {' · uploaded '}
                  {new Date(doc.uploaded_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </span>
                {!readOnly && (
                  <button
                    onClick={() => handleDelete(doc)}
                    className="text-xs text-red-600 hover:text-red-800 ml-auto"
                  >
                    Delete
                  </button>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Fill in the app — opens a guided form that fills + saves the
                      official PDF, no download/print needed. */}
                  {PDF_FORM_CONFIGS[spec.key] && (
                    <button
                      type="button"
                      onClick={() => setFilling(spec.key)}
                      className="px-3 py-1.5 text-sm rounded-md font-medium bg-brand-700 text-white hover:bg-brand-900"
                    >
                      ✏️ {doc ? 'Fill again' : 'Fill in app'}
                    </button>
                  )}
                  {/* Take a picture — `capture` opens the camera directly on
                      phones; desktop browsers ignore it and open a file dialog. */}
                  <label className="inline-flex items-center cursor-pointer">
                    <span
                      className={`px-3 py-1.5 text-sm rounded-md font-medium ${
                        doc || PDF_FORM_CONFIGS[spec.key]
                          ? 'border border-gray-300 hover:bg-gray-50'
                          : 'bg-brand-700 text-white hover:bg-brand-900'
                      } ${isUploading ? 'opacity-50' : ''}`}
                    >
                      {isUploading ? 'Uploading…' : '📷 Take a picture'}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleUpload(spec.key, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {/* Upload an existing file (photo, PDF, scan…). */}
                  <label className="inline-flex items-center cursor-pointer">
                    <span
                      className={`px-3 py-1.5 text-sm rounded-md font-medium border border-gray-300 hover:bg-gray-50 ${
                        isUploading ? 'opacity-50' : ''
                      }`}
                    >
                      {doc ? 'Replace file' : 'Upload a file'}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx"
                      className="hidden"
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleUpload(spec.key, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              )}
              {spec.templateUrl && (
                <a
                  href={spec.templateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-brand-700 hover:underline"
                >
                  {spec.templateLabel || 'Download blank form'} ↗
                </a>
              )}
            </div>
          </div>
        );
      })}

      {filling && PDF_FORM_CONFIGS[filling] && (
        <FillablePdfForm
          config={PDF_FORM_CONFIGS[filling]!}
          customerId={customerId}
          onClose={() => setFilling(null)}
          onSaved={() => { setFilling(null); load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
