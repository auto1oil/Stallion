'use client';
import { useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { createClient } from '@/lib/supabase-browser';
import type { PdfFormConfig } from '@/lib/pdf-forms';

// Modal that renders a guided form for a PDF (see lib/pdf-forms), fills the
// real AcroForm PDF with pdf-lib, flattens it, and saves it as the customer's
// document (customer-documents bucket + customer_documents row). No download.

const digits = (s: string) => s.replace(/\D/g, '');

export default function FillablePdfForm({
  config,
  customerId,
  onClose,
  onSaved,
}: {
  config: PdfFormConfig;
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createClient();
  const [text, setText] = useState<Record<string, string>>({});
  const [radio, setRadio] = useState<Record<string, string>>({}); // radio label -> chosen field
  const [ssn, setSsn] = useState('');
  const [ein, setEin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(field: string, value: string) {
    setText((t) => ({ ...t, [field]: value }));
  }

  function validate(): string | null {
    for (const sec of config.sections) {
      for (const f of sec.fields) {
        if (f.kind === 'text' && f.required && !(text[f.field] || '').trim()) {
          return `Please fill in "${f.label}".`;
        }
        if (f.kind === 'radio' && f.required && !radio[f.label]) {
          return `Please choose a "${f.label}".`;
        }
      }
    }
    if (config.tin) {
      const s = digits(ssn);
      const e = digits(ein);
      if (s.length === 0 && e.length === 0) return 'Please enter your SSN or EIN.';
      if (s.length > 0 && s.length !== 9) return 'SSN must be 9 digits.';
      if (e.length > 0 && e.length !== 9) return 'EIN must be 9 digits.';
    }
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError('');
    try {
      const ab = await fetch(config.blankUrl).then((r) => r.arrayBuffer());
      const pdf = await PDFDocument.load(ab);
      const form = pdf.getForm();

      for (const [field, value] of Object.entries(text)) {
        if (!value.trim()) continue;
        try { form.getTextField(field).setText(value); } catch { /* skip unknown */ }
      }
      for (const field of Object.values(radio)) {
        try { form.getCheckBox(field).check(); } catch { /* skip */ }
      }
      if (config.tin) {
        const s = digits(ssn);
        const e = digits(ein);
        if (s.length === 9) {
          const segs = [s.slice(0, 3), s.slice(3, 5), s.slice(5, 9)];
          config.tin.ssn.forEach((f, i) => { try { form.getTextField(f).setText(segs[i]); } catch {} });
        } else if (e.length === 9) {
          const segs = [e.slice(0, 2), e.slice(2, 9)];
          config.tin.ein.forEach((f, i) => { try { form.getTextField(f).setText(segs[i]); } catch {} });
        }
      }

      form.flatten();
      const bytes = await pdf.save();
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });

      // Replace any prior file for this doc type so storage doesn't bloat.
      const { data: prior } = await supabase
        .from('customer_documents')
        .select('file_path')
        .eq('customer_id', customerId)
        .eq('doc_type', config.docType)
        .maybeSingle();
      if (prior?.file_path) {
        await supabase.storage.from('customer-documents').remove([prior.file_path]);
      }

      const fileName = `${config.docType}.pdf`;
      const path = `${customerId}/${config.docType}-${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('customer-documents')
        .upload(path, blob, { upsert: false, contentType: 'application/pdf' });
      if (upErr) throw new Error(upErr.message);

      const { error: dbErr } = await supabase
        .from('customer_documents')
        .upsert({
          customer_id: customerId,
          doc_type: config.docType,
          file_path: path,
          file_name: fileName,
          file_size_bytes: blob.size,
          mime_type: 'application/pdf',
          uploaded_at: new Date().toISOString(),
        }, { onConflict: 'customer_id,doc_type' });
      if (dbErr) throw new Error(dbErr.message);

      setSaving(false);
      onSaved();
    } catch (e) {
      setSaving(false);
      setError(`Could not save: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-3">
      <div className="bg-white rounded-lg w-full max-w-lg my-4 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <h2 className="font-semibold text-brand-900 text-sm">{config.title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm" aria-label="Close">✕</button>
        </div>
        <div className="px-4 py-4 space-y-5">
          {config.intro && <p className="text-xs text-gray-500">{config.intro}</p>}

          {config.sections.map((sec, si) => (
            <div key={si} className="space-y-3">
              {sec.heading && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{sec.heading}</h3>
              )}
              {sec.fields.map((f, fi) => {
                if (f.kind === 'text') {
                  return (
                    <div key={fi} className={f.full ? '' : 'inline-block w-full'}>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        {f.label}{f.required && <span className="text-red-500"> *</span>}
                      </label>
                      <input
                        type="text"
                        value={text[f.field] || ''}
                        placeholder={f.placeholder}
                        onChange={(e) => setField(f.field, e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-base"
                      />
                      {f.help && <p className="text-[11px] text-gray-400 mt-1">{f.help}</p>}
                    </div>
                  );
                }
                if (f.kind === 'radio') {
                  return (
                    <div key={fi}>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        {f.label}{f.required && <span className="text-red-500"> *</span>}
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {f.options.map((opt) => (
                          <button
                            key={opt.field}
                            type="button"
                            onClick={() => setRadio((r) => ({ ...r, [f.label]: opt.field }))}
                            className={`px-3 py-2 text-sm border rounded-md text-left ${
                              radio[f.label] === opt.field
                                ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium'
                                : 'bg-white border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                }
                // TIN (W-9)
                return (
                  <div key={fi} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">SSN</label>
                      <input
                        type="text" inputMode="numeric" value={ssn} placeholder="123-45-6789"
                        onChange={(e) => setSsn(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-base tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">or EIN</label>
                      <input
                        type="text" inputMode="numeric" value={ein} placeholder="12-3456789"
                        onChange={(e) => setEin(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-base tabular-nums"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200 sticky bottom-0 bg-white rounded-b-lg">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 text-sm bg-brand-700 text-white font-medium rounded-md hover:bg-brand-900 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save document'}
          </button>
        </div>
      </div>
    </div>
  );
}
