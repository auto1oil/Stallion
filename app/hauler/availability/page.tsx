'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { isFreeOn, type HaulerAvailability, type HaulerEquipment } from '@/lib/haulers';

// Availability: the dates a hauler is free or blocked out. Every row is a
// window, not a single day, because that's how the yard actually talks —
// "we're down the week of the 10th", not fourteen separate marks.
//
// A blocked window always beats an available one on the same day, so marking
// September available and then blocking the 10th–14th reads the way you'd
// expect. The next fortnight is shown as a strip so it's obvious at a glance.

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function HaulerAvailabilityPage() {
  const supabase = createClient();
  const [windows, setWindows] = useState<HaulerAvailability[]>([]);
  const [fleet, setFleet] = useState<HaulerEquipment[]>([]);
  const [haulerId, setHaulerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({
    equipment_id: '', start_date: today(), end_date: today(),
    status: 'blocked' as 'blocked' | 'available', note: '',
  });

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase
      .from('profiles').select('hauler_id').eq('id', user.id).single();
    setHaulerId(profile?.hauler_id || null);
    const [{ data: a }, { data: e }] = await Promise.all([
      supabase.from('hauler_availability').select('*').order('start_date'),
      supabase.from('hauler_equipment').select('*').eq('active', true).order('unit_number'),
    ]);
    setWindows((a as HaulerAvailability[]) || []);
    setFleet((e as HaulerEquipment[]) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (draft.end_date < draft.start_date) {
      setError('The end date is before the start date.');
      return;
    }
    if (!haulerId) { setError('Your login is not linked to a company yet.'); return; }
    setBusy('add'); setError('');
    const { error: err } = await supabase.from('hauler_availability').insert({
      hauler_id: haulerId,
      equipment_id: draft.equipment_id || null,
      start_date: draft.start_date,
      end_date: draft.end_date,
      status: draft.status,
      note: draft.note.trim() || null,
    });
    setBusy('');
    if (err) { setError(err.message); return; }
    setDraft({ ...draft, note: '' });
    refresh();
  }

  async function remove(w: HaulerAvailability) {
    setBusy(w.id); setError('');
    const { error: err } = await supabase.from('hauler_availability').delete().eq('id', w.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const strip = Array.from({ length: 14 }, (_, i) => addDays(today(), i));

  return (
    <div className="space-y-4">
      <Link href="/hauler" className="text-sm text-brand-700 hover:underline">← Loads</Link>
      <h1 className="text-2xl font-semibold">Availability</h1>
      <p className="text-sm text-gray-600">
        Block out the days you can&apos;t run. Stallion sees this before sending
        you a load.
      </p>

      {/* Next two weeks at a glance */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 overflow-x-auto">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Next two weeks</h2>
        <div className="flex gap-1 min-w-max">
          {strip.map((d) => {
            const free = isFreeOn(windows, d, null)
              && (fleet.length === 0 || fleet.some((u) => isFreeOn(windows, d, u.id)));
            return (
              <div
                key={d}
                title={d}
                className={`w-11 shrink-0 rounded-md px-1 py-1.5 text-center border ${
                  free
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-800'
                }`}
              >
                <div className="text-[10px] uppercase">
                  {new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                <div className="text-sm font-semibold">{Number(d.slice(8, 10))}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add a window */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Mark dates</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label><span className={label}>From</span>
            <input type="date" value={draft.start_date}
              onChange={(e) => setDraft({
                ...draft,
                start_date: e.target.value,
                // Keep the range valid as they type rather than erroring later.
                end_date: draft.end_date < e.target.value ? e.target.value : draft.end_date,
              })}
              className={input} />
          </label>
          <label><span className={label}>To</span>
            <input type="date" value={draft.end_date} min={draft.start_date}
              onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} className={input} />
          </label>
          <label><span className={label}>Which unit</span>
            <select value={draft.equipment_id} onChange={(e) => setDraft({ ...draft, equipment_id: e.target.value })} className={input}>
              <option value="">Whole company</option>
              {fleet.map((u) => (
                <option key={u.id} value={u.id}>{u.unit_number || u.equipment_type || 'Unit'}</option>
              ))}
            </select>
          </label>
          <label><span className={label}>Mark as</span>
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as 'blocked' | 'available' })} className={input}>
              <option value="blocked">Blocked out</option>
              <option value="available">Available</option>
            </select>
          </label>
          <label className="col-span-2"><span className={label}>Note</span>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="In the shop" className={input} />
          </label>
        </div>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        <button
          onClick={add}
          disabled={busy === 'add'}
          className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
        >
          {busy === 'add' ? 'Saving…' : 'Save dates'}
        </button>
      </div>

      {/* Existing windows */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">On file</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : windows.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing marked — you&apos;re shown as available.</p>
        ) : (
          <div className="space-y-1.5">
            {windows.map((w) => {
              const unit = fleet.find((u) => u.id === w.equipment_id);
              return (
                <div key={w.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                  <span className="min-w-0">
                    <span className="font-medium">{w.start_date}</span>
                    {w.end_date !== w.start_date && <span className="font-medium"> → {w.end_date}</span>}
                    <span className="text-gray-500"> · {unit ? (unit.unit_number || 'unit') : 'whole company'}</span>
                    {w.note && <span className="text-gray-500"> · {w.note}</span>}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                      w.status === 'blocked'
                        ? 'bg-red-100 text-red-800 border-red-200'
                        : 'bg-emerald-100 text-emerald-900 border-emerald-200'
                    }`}>
                      {w.status === 'blocked' ? 'Blocked' : 'Available'}
                    </span>
                    <button onClick={() => remove(w)} disabled={busy === w.id}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50">
                      Remove
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
