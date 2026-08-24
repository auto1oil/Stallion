'use client';

// Generic fillable-PDF editor. Loads a blank PDF, reads whatever AcroForm
// fields it has (text / checkbox / dropdown / radio), shows an input for each,
// then fills + flattens the official PDF and saves it to the company document
// library (so it can be sent out). Works for any fillable blank (W-9, TC-721,
// etc.) without a hand-written field map; pass `labelMap` for friendlier
// labels. If the PDF has no fillable fields, it offers the blank to download.

import { useEffect, useState } from 'react';
import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup,
} from 'pdf-lib';

type Field =
  | { name: string; kind: 'text'; value: string }
  | { name: string; kind: 'check'; checked: boolean }
  | { name: string; kind: 'choice'; options: string[]; value: string };

function prettify(name: string): string {
  const tail = name.split('.').pop() || name;
  return tail.replace(/\[[0-9]+\]/g, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || name;
}

export default function BlankFormFiller({
  blankUrl, title, defaultName, labelMap, onClose, onSaved,
}: {
  blankUrl: string;
  title: string;
  defaultName: string;
  labelMap?: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveName, setSaveName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const ab = await fetch(blankUrl).then((r) => r.arrayBuffer());
        const pdf = await PDFDocument.load(ab);
        const out: Field[] = [];
        for (const f of pdf.getForm().getFields()) {
          const name = f.getName();
          if (f instanceof PDFTextField) out.push({ name, kind: 'text', value: f.getText() || '' });
          else if (f instanceof PDFCheckBox) out.push({ name, kind: 'check', checked: f.isChecked() });
          else if (f instanceof PDFDropdown) out.push({ name, kind: 'choice', options: f.getOptions(), value: f.getSelected()[0] || '' });
          else if (f instanceof PDFRadioGroup) out.push({ name, kind: 'choice', options: f.getOptions(), value: f.getSelected() || '' });
        }
        setFields(out);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : 'Could not open this form.');
      }
    })();
  }, [blankUrl]);

  function update(name: string, patch: Partial<Field>) {
    setFields((prev) => prev?.map((f) => (f.name === name ? { ...f, ...patch } as Field : f)) ?? prev);
  }

  async function save() {
    if (!fields) return;
    if (!saveName.trim()) { setError('Give the document a name first.'); return; }
    setSaving(true); setError('');
    try {
      const ab = await fetch(blankUrl).then((r) => r.arrayBuffer());
      const pdf = await PDFDocument.load(ab);
      const form = pdf.getForm();
      for (const f of fields) {
        try {
          if (f.kind === 'text') { if (f.value.trim()) form.getTextField(f.name).setText(f.value); }
          else if (f.kind === 'check') { const cb = form.getCheckBox(f.name); f.checked ? cb.check() : cb.uncheck(); }
          else if (f.kind === 'choice' && f.value) {
            try { form.getDropdown(f.name).select(f.value); } catch { form.getRadioGroup(f.name).select(f.value); }
          }
        } catch { /* skip a field that won't take the value */ }
      }
      form.flatten();
      const bytes = await pdf.save();
      const file = new File([new Uint8Array(bytes)], `${saveName.trim()}.pdf`, { type: 'application/pdf' });
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', `${saveName.trim()}.pdf`);
      fd.append('category', 'Filled forms');
      const res = await fetch('/api/admin/company-docs', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error || 'Could not save.'); return; }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const label = (n: string) => labelMap?.[n] || prettify(n);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-3" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-lg my-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <h2 className="font-semibold text-brand-900 text-sm">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm" aria-label="Close">✕</button>
        </div>
        <div className="px-4 py-4 space-y-3">
          {loadErr ? (
            <div className="text-sm text-gray-600">
              {loadErr}
              <div className="mt-2"><a href={blankUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">Download the blank to fill manually ↓</a></div>
            </div>
          ) : !fields ? (
            <p className="text-sm text-gray-500">Opening form…</p>
          ) : fields.length === 0 ? (
            <div className="text-sm text-gray-600">
              This form has no fillable boxes, so it can&apos;t be typed into here.
              <div className="mt-2"><a href={blankUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">Download the blank to fill manually ↓</a></div>
            </div>
          ) : (
            <>
              <label className="block text-xs text-gray-600">Save as (who it&apos;s for)
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
                  className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
              </label>
              <div className="space-y-2 border-t border-gray-100 pt-3">
                {fields.map((f) => (
                  <div key={f.name}>
                    {f.kind === 'text' && (
                      <label className="block text-xs text-gray-600">{label(f.name)}
                        <input value={f.value} onChange={(e) => update(f.name, { value: e.target.value })}
                          className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
                      </label>
                    )}
                    {f.kind === 'check' && (
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={f.checked} onChange={(e) => update(f.name, { checked: e.target.checked })} className="w-4 h-4" />
                        {label(f.name)}
                      </label>
                    )}
                    {f.kind === 'choice' && (
                      <label className="block text-xs text-gray-600">{label(f.name)}
                        <select value={f.value} onChange={(e) => update(f.name, { value: e.target.value })}
                          className="mt-1 w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
                          <option value="">—</option>
                          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                ))}
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button onClick={save} disabled={saving}
                  className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium">
                  {saving ? 'Saving…' : 'Save to documents'}
                </button>
                <button onClick={onClose} className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
