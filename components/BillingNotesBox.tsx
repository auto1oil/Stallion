'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Collapsible "special billing notes" editor for a business, shown on the
// admin Customers page. Notes surface on the admin Delivered orders view so
// the office knows how to send each customer's invoice (email, mail, call…).
export default function BillingNotesBox({
  businessId,
  initial,
}: {
  businessId: string;
  initial: string | null;
}) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(initial || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasNotes = (text || '').trim().length > 0;

  async function save() {
    setBusy(true);
    await supabase
      .from('businesses')
      .update({ billing_notes: text.trim() || null })
      .eq('id', businessId);
    setBusy(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="mb-3" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-brand-700 hover:underline inline-flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span>
        Special billing notes
        {hasNotes && <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-700" title="Has notes" />}
      </button>

      {open && (
        <div className="mt-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="e.g. When delivered: email AND regular-mail the invoice. (Landmark: email only.)"
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="px-3 py-1 text-sm bg-brand-700 text-white rounded hover:bg-brand-900 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-xs text-green-700">Saved ✓</span>}
          </div>
        </div>
      )}
      {!open && hasNotes && (
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{text.trim()}</p>
      )}
    </div>
  );
}
