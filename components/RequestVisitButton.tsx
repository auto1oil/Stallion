'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Compact "Request a sales rep visit" CTA + modal. Renders the list of
// reps that serve the customer's city (via salesmen_for_city RPC).

type Rep = {
  id: string;
  full_name: string | null;
  email: string;
  territory_counties: string[];
};

export default function RequestVisitButton({ className = '' }: { className?: string }) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [reps, setReps] = useState<Rep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [county, setCounty] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function openModal() {
    setOpen(true);
    setDone(false);
    setError('');
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    // Pull the customer's own county, falling back to the linked Business
    // county if the profile doesn't have one. Both are admin-managed fields.
    const { data: me } = await supabase
      .from('profiles')
      .select('county, business_id')
      .eq('id', user.id)
      .single();
    let myCounty = (me as { county: string | null } | null)?.county || null;
    if (!myCounty && (me as { business_id: string | null } | null)?.business_id) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id')
        .eq('id', (me as { business_id: string }).business_id)
        .single();
      void biz;
    }
    setCounty(myCounty);
    const { data: repRows } = await supabase.rpc('salesmen_for_county', { county_in: myCounty });
    setReps((repRows as Rep[]) || []);
    setLoading(false);
  }

  function close() {
    setOpen(false);
    setPicked(null);
    setNote('');
    setDone(false);
  }

  async function submit() {
    if (!picked) { setError('Pick a sales rep first.'); return; }
    setBusy(true);
    setError('');
    const res = await fetch('/api/salesman/request-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesman_profile_id: picked, note: note.trim() || null }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json.ok) { setError(json.error || 'Could not send request.'); return; }
    setDone(true);
  }

  return (
    <>
      <button
        onClick={openModal}
        className={`px-3 py-2 text-sm border border-brand-200 bg-brand-50 text-brand-800 rounded-md hover:bg-brand-100 font-medium ${className}`}
      >
        Request a sales rep visit
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold mb-1">Request a sales rep visit</h2>

            {done ? (
              <div className="space-y-3 mt-3">
                <p className="text-sm text-gray-700">
                  Request sent. Your sales rep will reach out to schedule the visit.
                </p>
                <button onClick={close} className="w-full py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
                  Done
                </button>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-3">
                  {county
                    ? <>Showing reps that cover <strong>{county}</strong>.</>
                    : 'Ask an admin to set your county so we can show only reps that cover your area.'}
                </p>

                {loading ? (
                  <p className="text-sm text-gray-500">Loading reps…</p>
                ) : !reps || reps.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No reps cover your county yet. We&apos;ll route the request manually — leave a note below.
                  </p>
                ) : (
                  <div className="space-y-1 mb-3">
                    {reps.map((r) => (
                      <label key={r.id} className={`flex items-start gap-2 px-3 py-2 border rounded-md cursor-pointer ${picked === r.id ? 'bg-brand-50 border-brand-500' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <input
                          type="radio"
                          name="rep"
                          checked={picked === r.id}
                          onChange={() => setPicked(r.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{r.full_name || r.email}</div>
                          {r.territory_counties && r.territory_counties.length > 0 && (
                            <div className="text-xs text-gray-500 mt-0.5">Covers: {r.territory_counties.join(', ')}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}

                <div className="mb-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Note (optional)</label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="What would you like to discuss?"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  />
                </div>

                {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

                <div className="flex justify-end gap-2">
                  <button onClick={close} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                  <button
                    onClick={submit}
                    disabled={busy || (reps !== null && reps.length > 0 && !picked)}
                    className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
                  >
                    {busy ? 'Sending…' : 'Send request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
