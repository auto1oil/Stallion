'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import ScanFill, { type ScanFields } from '@/components/ScanFill';
import {
  US_STATES, currentQuarter, recentQuarters, quarterLabel, quarterRange,
  iftaByState, expiryState, type FleetVehicle, type FleetFuel, type FleetTrip,
} from '@/lib/fleet';

// The fleet board: every truck Stallion runs, with the paperwork dates that
// bite (registration, insurance), and the quarter's IFTA table — miles run
// and gallons bought, by state — built off what the drivers log.

const EMPTY_TRUCK = {
  unit_number: '', year: '', make: '', model: '', vin: '',
  plate: '', plate_state: 'UT', registration_expires: '', insurance_expires: '', notes: '',
};

function ExpiryBadge({ label, date }: { label: string; date: string | null }) {
  const state = expiryState(date);
  if (!state) return null;
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
      state === 'expired'
        ? 'bg-red-100 text-red-800 border-red-200'
        : 'bg-amber-100 text-amber-900 border-amber-200'
    }`}>
      {label} {state === 'expired' ? 'expired' : 'expires soon'}
    </span>
  );
}

export default function FleetPage() {
  const supabase = createClient();
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([]);
  const [isStaff, setIsStaff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_TRUCK });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [quarter, setQuarter] = useState(currentQuarter());
  const [qTrips, setQTrips] = useState<FleetTrip[]>([]);
  const [qFuel, setQFuel] = useState<FleetFuel[]>([]);

  const refresh = useCallback(async () => {
    const [{ data: v }, { data: { user } }] = await Promise.all([
      supabase.from('fleet_vehicles').select('*').order('unit_number'),
      supabase.auth.getUser(),
    ]);
    setVehicles((v as FleetVehicle[]) || []);
    if (user) {
      const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setIsStaff(['admin', 'master_admin', 'office'].includes(p?.role || ''));
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  // The IFTA table re-pulls when the quarter changes.
  useEffect(() => {
    const { from, to } = quarterRange(quarter);
    let stale = false;
    Promise.all([
      supabase.from('fleet_trips').select('state, miles, vehicle_id, trip_date, id, from_place, to_place, notes, created_by, created_at')
        .gte('trip_date', from).lte('trip_date', to),
      supabase.from('fleet_fuel').select('state, gallons, vehicle_id, filled_on, id, odometer, total_cost, vendor, receipt_path, notes, created_by, created_at')
        .gte('filled_on', from).lte('filled_on', to),
    ]).then(([{ data: t }, { data: f }]) => {
      if (stale) return;
      setQTrips((t as FleetTrip[]) || []);
      setQFuel((f as FleetFuel[]) || []);
    });
    return () => { stale = true; };
  }, [supabase, quarter]);

  async function addTruck() {
    if (!draft.unit_number.trim()) { setError('Give the truck a unit number.'); return; }
    setBusy(true); setError('');
    const txt = (x: string) => (x.trim() === '' ? null : x.trim());
    const { error: err } = await supabase.from('fleet_vehicles').insert({
      unit_number: draft.unit_number.trim(),
      year: txt(draft.year), make: txt(draft.make), model: txt(draft.model),
      vin: txt(draft.vin), plate: txt(draft.plate), plate_state: txt(draft.plate_state),
      registration_expires: draft.registration_expires || null,
      insurance_expires: draft.insurance_expires || null,
      notes: txt(draft.notes),
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setDraft({ ...EMPTY_TRUCK });
    setAdding(false);
    refresh();
  }

  const ifta = iftaByState(qTrips, qFuel);
  const totalMiles = ifta.reduce((n, r) => n + r.miles, 0);
  const totalGallons = ifta.reduce((n, r) => n + r.gallons, 0);

  const input = 'w-full px-2.5 py-2 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const card = 'bg-white border border-gray-200 rounded-lg p-4';

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">Fleet</h1>
        {isStaff && (
          <button
            onClick={() => setAdding((a) => !a)}
            className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900"
          >
            {adding ? 'Close' : '+ Add a truck'}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {adding && (
        <div className={card}>
          {/* One photo of the registration card fills most of this form. */}
          <div className="mb-3">
            <ScanFill
              kind="registration"
              label="Scan the registration — fill this in"
              onFields={(f: ScanFields) => {
                const s = (v: string | number | null) => (v == null ? null : String(v));
                const st = s(f.plate_state)?.toUpperCase();
                setDraft((d) => ({
                  ...d,
                  year: s(f.year) ?? d.year,
                  make: s(f.make) ?? d.make,
                  model: s(f.model) ?? d.model,
                  vin: s(f.vin) ?? d.vin,
                  plate: s(f.plate) ?? d.plate,
                  plate_state: st && US_STATES.includes(st) ? st : d.plate_state,
                  registration_expires: s(f.registration_expires) ?? d.registration_expires,
                }));
              }}
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label><span className={label}>Unit #</span>
              <input value={draft.unit_number} onChange={(e) => setDraft({ ...draft, unit_number: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Year</span>
              <input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Make</span>
              <input value={draft.make} onChange={(e) => setDraft({ ...draft, make: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Model</span>
              <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className={input} />
            </label>
            <label className="col-span-2"><span className={label}>VIN</span>
              <input value={draft.vin} onChange={(e) => setDraft({ ...draft, vin: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Plate</span>
              <input value={draft.plate} onChange={(e) => setDraft({ ...draft, plate: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Plate state</span>
              <select value={draft.plate_state} onChange={(e) => setDraft({ ...draft, plate_state: e.target.value })} className={input}>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label><span className={label}>Registration expires</span>
              <input type="date" value={draft.registration_expires} onChange={(e) => setDraft({ ...draft, registration_expires: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Insurance expires</span>
              <input type="date" value={draft.insurance_expires} onChange={(e) => setDraft({ ...draft, insurance_expires: e.target.value })} className={input} />
            </label>
            <label className="col-span-2 sm:col-span-3"><span className={label}>Notes</span>
              <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={input} />
            </label>
          </div>
          <button
            onClick={addTruck}
            disabled={busy}
            className="mt-3 px-4 py-2 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Add truck'}
          </button>
        </div>
      )}

      {vehicles.length === 0 ? (
        <div className={card}>
          <p className="text-sm text-gray-500">
            No trucks yet — the fleet starts empty.
            {isStaff ? ' Add the first one above.' : ' The office adds them.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {vehicles.map((v) => (
            <Link
              key={v.id}
              href={`/fleet/${v.id}`}
              className="block bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-brand-300"
            >
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-medium text-sm">
                    Unit {v.unit_number}
                    {!v.active && <span className="ml-2 text-[11px] text-gray-500">(parked)</span>}
                  </span>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[[v.year, v.make, v.model].filter(Boolean).join(' '),
                      v.plate ? `Plate ${v.plate}${v.plate_state ? ` (${v.plate_state})` : ''}` : null,
                    ].filter(Boolean).join(' · ') || 'No details yet'}
                  </div>
                </div>
                <div className="flex gap-1.5 flex-wrap shrink-0">
                  <ExpiryBadge label="Registration" date={v.registration_expires} />
                  <ExpiryBadge label="Insurance" date={v.insurance_expires} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className={card}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            IFTA — miles and fuel by state
          </h2>
          <select
            value={quarter}
            onChange={(e) => setQuarter(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded-md text-sm"
          >
            {recentQuarters(8).map((q) => <option key={q} value={q}>{quarterLabel(q)}</option>)}
          </select>
        </div>
        {ifta.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing logged this quarter yet. Miles come from trips, gallons from
            fuel fills — both are logged on each truck&apos;s page.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                <th className="py-1.5 font-medium">State</th>
                <th className="py-1.5 font-medium text-right">Miles</th>
                <th className="py-1.5 font-medium text-right">Gallons</th>
              </tr>
            </thead>
            <tbody>
              {ifta.map((r) => (
                <tr key={r.state} className="border-b border-gray-100 last:border-0">
                  <td className="py-1.5">{r.state === '??' ? 'No state given' : r.state}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.miles.toFixed(1)}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.gallons.toFixed(3)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right tabular-nums">{totalMiles.toFixed(1)}</td>
                <td className="py-1.5 text-right tabular-nums">{totalGallons.toFixed(3)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
