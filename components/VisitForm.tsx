'use client';
import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Shape of an existing visit being edited. Null when logging a new one.
export type EditableVisit = {
  id: string;
  business_name: string;
  city: string | null;
  contact_person: string | null;
  notes: string | null;
} | null;

// A business the rep can pick from instead of typing the name by hand. Used
// to power the type-ahead so a mistyped name doesn't log against the wrong
// (or a brand-new) business.
export type BusinessSuggestion = { name: string; city: string | null };

function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Modal form for logging a new field visit or editing an existing one. Shared
// between the salesman home ("My visits") and the Customers Visited tab so a
// rep can log a stop from either place. New visits are stamped with the
// current time/date and the rep's own id (RLS only lets them insert own rows).
export default function VisitForm({
  visit,
  salesmanId,
  salesmanName,
  onClose,
  onSaved,
  suggestions = [],
  defaultBusinessName,
  defaultCity,
}: {
  visit: EditableVisit;
  salesmanId: string;
  salesmanName: string;
  onClose: () => void;
  onSaved: () => void;
  /** Names to offer as type-ahead matches on the business field. */
  suggestions?: BusinessSuggestion[];
  /** Pre-fill the business name when logging a new visit (e.g. logging a
   *  visit straight from a known customer row). */
  defaultBusinessName?: string;
  defaultCity?: string | null;
}) {
  const supabase = createClient();
  const [businessName, setBusinessName] = useState(visit?.business_name ?? defaultBusinessName ?? '');
  const [city, setCity] = useState(visit?.city ?? defaultCity ?? '');
  const [contactPerson, setContactPerson] = useState(visit?.contact_person || '');
  const [notes, setNotes] = useState(visit?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSug, setShowSug] = useState(false);

  // Matches whose name begins with what's been typed (whole name or any word
  // start), so typing the first part of "Joe's Auto" surfaces it. Hidden once
  // the field already exactly equals a suggestion (i.e. one was picked).
  const matches = useMemo(() => {
    const q = businessName.trim().toLowerCase();
    if (!q) return [];
    return suggestions
      .filter((s) => {
        const n = s.name.toLowerCase();
        if (n === q) return false;
        return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
      })
      .slice(0, 8);
  }, [businessName, suggestions]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!businessName.trim()) {
      setError('Business name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (visit) {
        const { error: upErr } = await supabase
          .from('salesman_visits')
          .update({
            business_name: businessName.trim(),
            city: city.trim() || null,
            contact_person: contactPerson.trim() || null,
            notes: notes.trim() || null,
          })
          .eq('id', visit.id);
        if (upErr) throw upErr;
      } else {
        const now = new Date();
        const { error: insErr } = await supabase.from('salesman_visits').insert({
          salesman_id: salesmanId,
          salesman_name: salesmanName,
          business_name: businessName.trim(),
          city: city.trim() || null,
          contact_person: contactPerson.trim() || null,
          notes: notes.trim() || null,
          visit_date: todayLocalISO(),
          visit_at: now.toISOString(),
        });
        if (insErr) throw insErr;
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-lg font-semibold mb-1">
            {visit ? 'Edit visit' : 'Log visit'}
          </h2>
          {!visit && (
            <p className="text-xs text-gray-500 mb-4">
              Time-stamped automatically as {new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} — {salesmanName}
            </p>
          )}
          <form onSubmit={handleSave} className="space-y-3">
            <div className="relative">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Business name <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => { setBusinessName(e.target.value); setShowSug(true); }}
                onFocus={() => setShowSug(true)}
                onBlur={() => setTimeout(() => setShowSug(false), 120)}
                autoComplete="off"
                required
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="Start typing to find an existing customer…"
              />
              {showSug && matches.length > 0 && (
                <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-52 overflow-y-auto">
                  {matches.map((s, i) => (
                    <li key={`${s.name}-${i}`}>
                      <button
                        type="button"
                        // mousedown fires before the input's blur, so the
                        // pick lands before the dropdown closes.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setBusinessName(s.name);
                          setCity(s.city || '');
                          setShowSug(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50"
                      >
                        <span className="font-medium">{s.name}</span>
                        {s.city && <span className="text-gray-500"> · {s.city}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                City
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="e.g. Lehi"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Person you spoke with
              </label>
              <input
                type="text"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="e.g. Jim Smith"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="What you discussed, follow-up needed, etc."
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50"
              >
                {saving ? 'Saving…' : visit ? 'Save changes' : 'Log visit'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
