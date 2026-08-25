'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { TRAILER_TYPES, type HaulerEquipment } from '@/lib/haulers';

// The hauler's own fleet. They add and retire their trucks here; the office
// sees the same list on the hauler's page and picks from it when sending a
// load. RLS scopes every row to the signed-in user's company, so hauler_id is
// filled in from their profile rather than being anything the form can set.
//
// A unit is the truck, and its trailers are a list: the same tractor might
// have a belly dump and an end dump available and swap between them week to
// week. That's why trailers are editable on the row rather than only at the
// point the unit is added.

// The truck itself, not what it pulls.
const TRUCK_TYPES = [
  'Tractor', 'Truck & Pup', 'Water Truck', 'Super Dump', 'End Dump',
  'Lowboy', 'Excavator', 'Loader', 'Dozer', 'Blade', 'Skid Steer',
];

export default function HaulerEquipmentPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<HaulerEquipment[]>([]);
  const [haulerId, setHaulerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editingTrailers, setEditingTrailers] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    unit_number: '', equipment_type: '', capacity: '', description: '',
  });
  const [draftTrailers, setDraftTrailers] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase
      .from('profiles').select('hauler_id').eq('id', user.id).single();
    setHaulerId(profile?.hauler_id || null);
    const { data } = await supabase
      .from('hauler_equipment').select('*').order('unit_number');
    setRows((data as HaulerEquipment[]) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (!draft.unit_number.trim() && !draft.equipment_type.trim()) {
      setError('Give it a unit number or a type so it can be told apart.');
      return;
    }
    if (!haulerId) { setError('Your login is not linked to a company yet.'); return; }
    setBusy('add'); setError('');
    const { error: err } = await supabase.from('hauler_equipment').insert({
      hauler_id: haulerId,
      unit_number: draft.unit_number.trim() || null,
      equipment_type: draft.equipment_type.trim() || null,
      trailer_types: draftTrailers,
      capacity: draft.capacity.trim() || null,
      description: draft.description.trim() || null,
    });
    setBusy('');
    if (err) { setError(err.message); return; }
    setDraft({ unit_number: '', equipment_type: '', capacity: '', description: '' });
    setDraftTrailers([]);
    refresh();
  }

  async function saveTrailers(u: HaulerEquipment, trailers: string[]) {
    setBusy(u.id); setError('');
    const { error: err } = await supabase
      .from('hauler_equipment').update({ trailer_types: trailers }).eq('id', u.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    // Keep the row responsive while the list reloads underneath.
    setRows((rs) => rs.map((r) => (r.id === u.id ? { ...r, trailer_types: trailers } : r)));
  }

  async function toggleActive(u: HaulerEquipment) {
    setBusy(u.id); setError('');
    const { error: err } = await supabase
      .from('hauler_equipment').update({ active: !u.active }).eq('id', u.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  async function remove(u: HaulerEquipment) {
    setBusy(u.id); setError('');
    const { error: err } = await supabase.from('hauler_equipment').delete().eq('id', u.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';

  function trailerChips(selected: string[], onToggle: (t: string) => void, disabled = false) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {TRAILER_TYPES.map((t) => {
          const on = selected.includes(t);
          return (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(t)}
              className={`px-2.5 py-1 text-xs rounded-full border disabled:opacity-50 ${
                on
                  ? 'bg-brand-700 text-white border-brand-700 font-medium'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/hauler" className="text-sm text-brand-700 hover:underline">← Loads</Link>
      <h1 className="text-2xl font-semibold">Trucks &amp; equipment</h1>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Add a unit</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label><span className={label}>Unit #</span>
            <input value={draft.unit_number} onChange={(e) => setDraft({ ...draft, unit_number: e.target.value })} className={input} />
          </label>
          <label><span className={label}>Truck type</span>
            <input value={draft.equipment_type} onChange={(e) => setDraft({ ...draft, equipment_type: e.target.value })} className={input} list="truck-types" />
            <datalist id="truck-types">
              {TRUCK_TYPES.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>
          <label><span className={label}>Capacity</span>
            <input value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} placeholder="24 ton" className={input} />
          </label>
          <label><span className={label}>Notes</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={input} />
          </label>
        </div>

        <div className="mt-3">
          <span className={label}>Trailers available</span>
          <p className="text-[11px] text-gray-500 mb-2">
            Everything this unit can pull. Tick as many as apply — Stallion uses
            it to work out who can take a load.
          </p>
          {trailerChips(draftTrailers, (t) =>
            setDraftTrailers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t])))}
        </div>

        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        <button
          onClick={add}
          disabled={busy === 'add'}
          className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
        >
          {busy === 'add' ? 'Adding…' : 'Add unit'}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
          Your fleet {rows.length > 0 && `— ${rows.filter((r) => r.active).length} active`}
        </h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing on file yet. Add your first unit above.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((u) => (
              <div key={u.id} className="border-b border-gray-100 last:border-0 pb-3 last:pb-0">
                <div className="flex justify-between items-start gap-3 text-sm">
                  <span className="min-w-0">
                    <span className={`font-medium ${u.active ? '' : 'text-gray-400 line-through'}`}>
                      {u.unit_number || 'Unit'}
                    </span>
                    <span className="text-gray-500"> · {[u.equipment_type, u.capacity, u.description].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                  <span className="flex gap-2 shrink-0">
                    <button onClick={() => toggleActive(u)} disabled={busy === u.id}
                      className="text-xs text-brand-700 hover:underline disabled:opacity-50">
                      {u.active ? 'Retire' : 'Bring back'}
                    </button>
                    <button onClick={() => remove(u)} disabled={busy === u.id}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50">
                      Delete
                    </button>
                  </span>
                </div>

                <div className="mt-1.5">
                  {editingTrailers === u.id ? (
                    <>
                      {trailerChips(
                        u.trailer_types || [],
                        (t) => {
                          const cur = u.trailer_types || [];
                          saveTrailers(u, cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
                        },
                        busy === u.id,
                      )}
                      <button
                        onClick={() => setEditingTrailers(null)}
                        className="mt-2 text-xs text-brand-700 hover:underline"
                      >
                        Done
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      {(u.trailer_types || []).length > 0 ? (
                        (u.trailer_types || []).map((t) => (
                          <span key={t} className="px-2 py-0.5 text-[11px] rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                            {t}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-gray-400">No trailers listed</span>
                      )}
                      <button
                        onClick={() => setEditingTrailers(u.id)}
                        className="text-xs text-brand-700 hover:underline"
                      >
                        Edit trailers
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
