'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import TicketAttachment from '@/components/TicketAttachment';
import ScanFill, { type ScanFields } from '@/components/ScanFill';
import {
  US_STATES, expiryState, vehicleLabel,
  type FleetVehicle, type FleetFuel, type FleetTrip, type FleetService, type FleetDocument,
} from '@/lib/fleet';

// One truck: its paperwork dates, and everything logged against it — fuel
// fills (with the receipt), trip miles by state, maintenance and repairs,
// and its documents. Drivers log from here in the cab; the office edits the
// truck itself.

const BUCKET = 'work-tickets';

export default function FleetVehiclePage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const [vehicle, setVehicle] = useState<FleetVehicle | null>(null);
  const [fuel, setFuel] = useState<FleetFuel[]>([]);
  const [trips, setTrips] = useState<FleetTrip[]>([]);
  const [service, setService] = useState<FleetService[]>([]);
  const [docs, setDocs] = useState<FleetDocument[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<FleetVehicle>>({});
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const today = () => new Date().toISOString().slice(0, 10);
  const [fuelDraft, setFuelDraft] = useState({ filled_on: today(), state: 'UT', odometer: '', gallons: '', total_cost: '', vendor: '', receipt_path: null as string | null });
  const [tripDraft, setTripDraft] = useState({ trip_date: today(), from_place: '', to_place: '', state: 'UT', miles: '' });
  const [svcDraft, setSvcDraft] = useState({ service_date: today(), kind: 'maintenance', odometer: '', description: '', cost: '', receipt_path: null as string | null });
  const [docDraft, setDocDraft] = useState({ label: '', expires_on: '', file_path: null as string | null });

  const refresh = useCallback(async () => {
    const [{ data: v }, { data: f }, { data: t }, { data: s }, { data: d }, { data: { user } }] = await Promise.all([
      supabase.from('fleet_vehicles').select('*').eq('id', params.id).maybeSingle(),
      supabase.from('fleet_fuel').select('*').eq('vehicle_id', params.id).order('filled_on', { ascending: false }).limit(200),
      supabase.from('fleet_trips').select('*').eq('vehicle_id', params.id).order('trip_date', { ascending: false }).limit(200),
      supabase.from('fleet_service').select('*').eq('vehicle_id', params.id).order('service_date', { ascending: false }).limit(200),
      supabase.from('fleet_documents').select('*').eq('vehicle_id', params.id).order('created_at', { ascending: false }),
      supabase.auth.getUser(),
    ]);
    if (!v) { setError('That truck is no longer in the fleet.'); return; }
    setVehicle(v as FleetVehicle);
    setForm(v as FleetVehicle);
    setFuel((f as FleetFuel[]) || []);
    setTrips((t as FleetTrip[]) || []);
    setService((s as FleetService[]) || []);
    setDocs((d as FleetDocument[]) || []);
    if (user) {
      setMe(user.id);
      const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setIsStaff(['admin', 'master_admin', 'office'].includes(p?.role || ''));
    }
  }, [supabase, params.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const num = (x: string) => (x.trim() === '' ? null : Number(x));
  const txt = (x: string) => (x.trim() === '' ? null : x.trim());

  async function insertRow(table: string, row: Record<string, unknown>, after: () => void) {
    setBusy(table); setError('');
    const { error: err } = await supabase.from(table).insert({ ...row, vehicle_id: params.id, created_by: me });
    setBusy('');
    if (err) { setError(err.message); return; }
    after();
    setOpen('');
    refresh();
  }

  async function removeRow(table: string, id: string) {
    setBusy(id); setError('');
    const { error: err } = await supabase.from(table).delete().eq('id', id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
  }

  async function saveTruck() {
    setBusy('truck'); setError('');
    const { error: err } = await supabase.from('fleet_vehicles').update({
      unit_number: (form.unit_number || '').trim() || vehicle?.unit_number,
      year: form.year || null, make: form.make || null, model: form.model || null,
      vin: form.vin || null, plate: form.plate || null, plate_state: form.plate_state || null,
      registration_expires: form.registration_expires || null,
      insurance_expires: form.insurance_expires || null,
      active: form.active ?? true,
      notes: form.notes || null,
    }).eq('id', params.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    setEditing(false);
    refresh();
  }

  // Fresh signed URL at tap time; tab opened before the await (Safari).
  async function openFile(path: string) {
    const tab = window.open('about:blank', '_blank');
    const { data, error: err } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
    if (err || !data?.signedUrl) { tab?.close(); setError('Could not open that file — try again.'); return; }
    if (tab) tab.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  const canDelete = (createdBy: string | null) => isStaff || (!!me && createdBy === me);

  // Merging scanned fields into a draft: a value the scanner couldn't read
  // never wipes what's already typed.
  const sv = (v: string | number | null) => (v == null ? null : String(v));
  const stOf = (v: string | number | null) => {
    const st = sv(v)?.toUpperCase();
    return st && US_STATES.includes(st) ? st : null;
  };

  const input = 'w-full px-2.5 py-2 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const card = 'bg-white border border-gray-200 rounded-lg p-4';
  const addBtn = 'px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50';
  const money = (v: number | null) => (v == null ? null : `$${Number(v).toFixed(2)}`);

  if (error && !vehicle) return <p className="text-sm text-red-600">{error}</p>;
  if (!vehicle) return <p className="text-sm text-gray-500">Loading…</p>;

  function sectionHead(title: string, key: string, openLabel: string) {
    return (
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
        <button
          onClick={() => setOpen(open === key ? '' : key)}
          className="text-sm text-brand-700 hover:underline"
        >
          {open === key ? 'Close' : openLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/fleet" className="text-sm text-brand-700 hover:underline">← Fleet</Link>

      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">{vehicleLabel(vehicle)}</h1>
        {isStaff && (
          <button onClick={() => setEditing((e) => !e)} className="text-sm text-brand-700 hover:underline">
            {editing ? 'Close' : 'Edit truck'}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className={card}>
        {editing ? (
          <>
            <div className="mb-3">
              <ScanFill
                kind="registration"
                label="Scan the registration — fill this in"
                onFields={(f: ScanFields) => setForm((p) => ({
                  ...p,
                  year: sv(f.year) ?? p.year,
                  make: sv(f.make) ?? p.make,
                  model: sv(f.model) ?? p.model,
                  vin: sv(f.vin) ?? p.vin,
                  plate: sv(f.plate) ?? p.plate,
                  plate_state: stOf(f.plate_state) ?? p.plate_state,
                  registration_expires: sv(f.registration_expires) ?? p.registration_expires,
                }))}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label><span className={label}>Unit #</span>
                <input value={form.unit_number || ''} onChange={(e) => setForm({ ...form, unit_number: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Year</span>
                <input value={form.year || ''} onChange={(e) => setForm({ ...form, year: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Make</span>
                <input value={form.make || ''} onChange={(e) => setForm({ ...form, make: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Model</span>
                <input value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} className={input} />
              </label>
              <label className="col-span-2"><span className={label}>VIN</span>
                <input value={form.vin || ''} onChange={(e) => setForm({ ...form, vin: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Plate</span>
                <input value={form.plate || ''} onChange={(e) => setForm({ ...form, plate: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Plate state</span>
                <select value={form.plate_state || 'UT'} onChange={(e) => setForm({ ...form, plate_state: e.target.value })} className={input}>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label><span className={label}>Registration expires</span>
                <input type="date" value={form.registration_expires || ''} onChange={(e) => setForm({ ...form, registration_expires: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Insurance expires</span>
                <input type="date" value={form.insurance_expires || ''} onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })} className={input} />
              </label>
              <label className="flex items-center gap-2 mt-5 text-sm">
                <input type="checkbox" checked={form.active ?? true} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4" />
                In service
              </label>
              <label className="col-span-2 sm:col-span-3"><span className={label}>Notes</span>
                <textarea rows={2} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={input} />
              </label>
            </div>
            <button onClick={saveTruck} disabled={busy === 'truck'} className={`mt-3 ${addBtn}`}>
              {busy === 'truck' ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
            {([
              ['VIN', vehicle.vin],
              ['Plate', vehicle.plate ? `${vehicle.plate}${vehicle.plate_state ? ` (${vehicle.plate_state})` : ''}` : null],
              ['Registration expires', vehicle.registration_expires],
              ['Insurance expires', vehicle.insurance_expires],
              ['Status', vehicle.active ? 'In service' : 'Parked'],
              ['Notes', vehicle.notes],
            ] as [string, string | null][]).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-gray-500">{k}</dt>
                <dd className={k.includes('expires') && expiryState(v) === 'expired' ? 'text-red-600 font-medium' : ''}>
                  {v || <span className="text-gray-400">—</span>}
                  {k.includes('expires') && expiryState(v) === 'expired' ? ' — expired' : ''}
                  {k.includes('expires') && expiryState(v) === 'soon' ? ' — soon' : ''}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* ---- Fuel ---- */}
      <div className={card}>
        {sectionHead('Fuel log', 'fuel', '+ Log fuel')}
        {open === 'fuel' && (
          <div className="border border-gray-200 rounded-md p-3 mb-3 bg-gray-50">
            {/* One photo of the pump receipt fills the entry AND attaches it. */}
            <div className="mb-3">
              <ScanFill
                kind="fuel"
                label="Scan the receipt — fill this in"
                uploadFolder="fleet"
                onUploaded={(p) => setFuelDraft((d) => ({ ...d, receipt_path: p }))}
                onFields={(f: ScanFields) => setFuelDraft((d) => ({
                  ...d,
                  filled_on: sv(f.filled_on) ?? d.filled_on,
                  state: stOf(f.state) ?? d.state,
                  gallons: sv(f.gallons) ?? d.gallons,
                  total_cost: sv(f.total_cost) ?? d.total_cost,
                  vendor: sv(f.vendor) ?? d.vendor,
                  odometer: sv(f.odometer) ?? d.odometer,
                }))}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label><span className={label}>Date</span>
                <input type="date" value={fuelDraft.filled_on} onChange={(e) => setFuelDraft({ ...fuelDraft, filled_on: e.target.value })} className={input} />
              </label>
              <label><span className={label}>State bought in</span>
                <select value={fuelDraft.state} onChange={(e) => setFuelDraft({ ...fuelDraft, state: e.target.value })} className={input}>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label><span className={label}>Odometer</span>
                <input type="number" inputMode="decimal" value={fuelDraft.odometer} onChange={(e) => setFuelDraft({ ...fuelDraft, odometer: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Gallons</span>
                <input type="number" step="0.001" inputMode="decimal" value={fuelDraft.gallons} onChange={(e) => setFuelDraft({ ...fuelDraft, gallons: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Total cost ($)</span>
                <input type="number" step="0.01" inputMode="decimal" value={fuelDraft.total_cost} onChange={(e) => setFuelDraft({ ...fuelDraft, total_cost: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Station / vendor</span>
                <input value={fuelDraft.vendor} onChange={(e) => setFuelDraft({ ...fuelDraft, vendor: e.target.value })} className={input} />
              </label>
            </div>
            <div className="mt-3">
              <TicketAttachment
                label="Fuel receipt"
                hint="Scan the pump receipt."
                folder="fleet"
                path={fuelDraft.receipt_path}
                onChange={(p) => setFuelDraft({ ...fuelDraft, receipt_path: p })}
              />
            </div>
            <button
              disabled={busy === 'fleet_fuel'}
              onClick={() => insertRow('fleet_fuel', {
                filled_on: fuelDraft.filled_on, state: fuelDraft.state,
                odometer: num(fuelDraft.odometer), gallons: num(fuelDraft.gallons),
                total_cost: num(fuelDraft.total_cost), vendor: txt(fuelDraft.vendor),
                receipt_path: fuelDraft.receipt_path,
              }, () => setFuelDraft({ filled_on: today(), state: fuelDraft.state, odometer: '', gallons: '', total_cost: '', vendor: '', receipt_path: null }))}
              className={`mt-3 ${addBtn}`}
            >
              {busy === 'fleet_fuel' ? 'Saving…' : 'Log fuel'}
            </button>
          </div>
        )}
        {fuel.length === 0 ? (
          <p className="text-sm text-gray-500">No fuel logged on this truck yet.</p>
        ) : (
          <div className="space-y-1.5">
            {fuel.map((f) => (
              <div key={f.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className="font-medium">{f.filled_on}</span>
                  <span className="text-gray-500">
                    {' · '}
                    {[
                      f.gallons != null ? `${Number(f.gallons).toFixed(3)} gal` : null,
                      money(f.total_cost),
                      f.state,
                      f.vendor,
                      f.odometer != null ? `odo ${Number(f.odometer).toFixed(0)}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  {f.receipt_path && (
                    <button onClick={() => openFile(f.receipt_path!)} className="text-xs text-brand-700 hover:underline">Receipt</button>
                  )}
                  {canDelete(f.created_by) && (
                    <button onClick={() => removeRow('fleet_fuel', f.id)} disabled={busy === f.id} className="text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Trips ---- */}
      <div className={card}>
        {sectionHead('Trips — IFTA miles', 'trip', '+ Log a trip')}
        {open === 'trip' && (
          <div className="border border-gray-200 rounded-md p-3 mb-3 bg-gray-50">
            <p className="text-xs text-gray-500 mb-3">
              Miles are logged per state — a run that crosses a state line is
              one entry for each state&apos;s share of the miles.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label><span className={label}>Date</span>
                <input type="date" value={tripDraft.trip_date} onChange={(e) => setTripDraft({ ...tripDraft, trip_date: e.target.value })} className={input} />
              </label>
              <label><span className={label}>From</span>
                <input value={tripDraft.from_place} onChange={(e) => setTripDraft({ ...tripDraft, from_place: e.target.value })} className={input} />
              </label>
              <label><span className={label}>To</span>
                <input value={tripDraft.to_place} onChange={(e) => setTripDraft({ ...tripDraft, to_place: e.target.value })} className={input} />
              </label>
              <label><span className={label}>State</span>
                <select value={tripDraft.state} onChange={(e) => setTripDraft({ ...tripDraft, state: e.target.value })} className={input}>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label><span className={label}>Miles</span>
                <input type="number" step="0.1" inputMode="decimal" value={tripDraft.miles} onChange={(e) => setTripDraft({ ...tripDraft, miles: e.target.value })} className={input} />
              </label>
            </div>
            <button
              disabled={busy === 'fleet_trips'}
              onClick={() => insertRow('fleet_trips', {
                trip_date: tripDraft.trip_date, from_place: txt(tripDraft.from_place),
                to_place: txt(tripDraft.to_place), state: tripDraft.state, miles: num(tripDraft.miles),
              }, () => setTripDraft({ trip_date: today(), from_place: '', to_place: '', state: tripDraft.state, miles: '' }))}
              className={`mt-3 ${addBtn}`}
            >
              {busy === 'fleet_trips' ? 'Saving…' : 'Log trip'}
            </button>
          </div>
        )}
        {trips.length === 0 ? (
          <p className="text-sm text-gray-500">No trips logged on this truck yet.</p>
        ) : (
          <div className="space-y-1.5">
            {trips.map((t) => (
              <div key={t.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className="font-medium">{t.trip_date}</span>
                  <span className="text-gray-500">
                    {' · '}
                    {[
                      t.from_place && t.to_place ? `${t.from_place} → ${t.to_place}` : (t.from_place || t.to_place),
                      t.miles != null ? `${Number(t.miles).toFixed(1)} mi` : null,
                      t.state,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {canDelete(t.created_by) && (
                  <button onClick={() => removeRow('fleet_trips', t.id)} disabled={busy === t.id} className="shrink-0 text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Service & repairs ---- */}
      <div className={card}>
        {sectionHead('Maintenance & repairs', 'svc', '+ Log work')}
        {open === 'svc' && (
          <div className="border border-gray-200 rounded-md p-3 mb-3 bg-gray-50">
            {/* One photo of the shop bill fills the entry AND attaches it. */}
            <div className="mb-3">
              <ScanFill
                kind="service"
                label="Scan the bill — fill this in"
                uploadFolder="fleet"
                onUploaded={(p) => setSvcDraft((d) => ({ ...d, receipt_path: p }))}
                onFields={(f: ScanFields) => setSvcDraft((d) => ({
                  ...d,
                  service_date: sv(f.service_date) ?? d.service_date,
                  kind: f.kind === 'repair' || f.kind === 'maintenance' ? f.kind : d.kind,
                  description: sv(f.description) ?? d.description,
                  cost: sv(f.cost) ?? d.cost,
                  odometer: sv(f.odometer) ?? d.odometer,
                }))}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label><span className={label}>Date</span>
                <input type="date" value={svcDraft.service_date} onChange={(e) => setSvcDraft({ ...svcDraft, service_date: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Kind</span>
                <select value={svcDraft.kind} onChange={(e) => setSvcDraft({ ...svcDraft, kind: e.target.value })} className={input}>
                  <option value="maintenance">Maintenance</option>
                  <option value="repair">Repair</option>
                </select>
              </label>
              <label><span className={label}>Odometer</span>
                <input type="number" inputMode="decimal" value={svcDraft.odometer} onChange={(e) => setSvcDraft({ ...svcDraft, odometer: e.target.value })} className={input} />
              </label>
              <label className="col-span-2"><span className={label}>What was done</span>
                <input value={svcDraft.description} onChange={(e) => setSvcDraft({ ...svcDraft, description: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Cost ($)</span>
                <input type="number" step="0.01" inputMode="decimal" value={svcDraft.cost} onChange={(e) => setSvcDraft({ ...svcDraft, cost: e.target.value })} className={input} />
              </label>
            </div>
            <div className="mt-3">
              <TicketAttachment
                label="Invoice / receipt"
                hint="The shop invoice or parts receipt."
                folder="fleet"
                path={svcDraft.receipt_path}
                onChange={(p) => setSvcDraft({ ...svcDraft, receipt_path: p })}
              />
            </div>
            <button
              disabled={busy === 'fleet_service'}
              onClick={() => insertRow('fleet_service', {
                service_date: svcDraft.service_date, kind: svcDraft.kind,
                odometer: num(svcDraft.odometer), description: txt(svcDraft.description),
                cost: num(svcDraft.cost), receipt_path: svcDraft.receipt_path,
              }, () => setSvcDraft({ service_date: today(), kind: 'maintenance', odometer: '', description: '', cost: '', receipt_path: null }))}
              className={`mt-3 ${addBtn}`}
            >
              {busy === 'fleet_service' ? 'Saving…' : 'Log work'}
            </button>
          </div>
        )}
        {service.length === 0 ? (
          <p className="text-sm text-gray-500">No maintenance or repairs logged yet.</p>
        ) : (
          <div className="space-y-1.5">
            {service.map((s) => (
              <div key={s.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className="font-medium">{s.service_date}</span>
                  <span className={`ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded-full border ${s.kind === 'repair' ? 'bg-red-100 text-red-800 border-red-200' : 'bg-blue-100 text-blue-900 border-blue-200'}`}>
                    {s.kind === 'repair' ? 'Repair' : 'Maintenance'}
                  </span>
                  <span className="text-gray-500">
                    {' · '}
                    {[s.description, money(s.cost), s.odometer != null ? `odo ${Number(s.odometer).toFixed(0)}` : null]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  {s.receipt_path && (
                    <button onClick={() => openFile(s.receipt_path!)} className="text-xs text-brand-700 hover:underline">Receipt</button>
                  )}
                  {canDelete(s.created_by) && (
                    <button onClick={() => removeRow('fleet_service', s.id)} disabled={busy === s.id} className="text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Documents ---- */}
      <div className={card}>
        {sectionHead('Documents', 'doc', '+ Add a document')}
        {open === 'doc' && (
          <div className="border border-gray-200 rounded-md p-3 mb-3 bg-gray-50">
            <div className="grid grid-cols-2 gap-3">
              <label><span className={label}>What is it</span>
                <input value={docDraft.label} placeholder="Registration, cab card, insurance…" onChange={(e) => setDocDraft({ ...docDraft, label: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Expires (optional)</span>
                <input type="date" value={docDraft.expires_on} onChange={(e) => setDocDraft({ ...docDraft, expires_on: e.target.value })} className={input} />
              </label>
            </div>
            <div className="mt-3">
              <TicketAttachment
                label="Document"
                hint="Scan it or attach the PDF."
                folder="fleet"
                path={docDraft.file_path}
                onChange={(p) => setDocDraft({ ...docDraft, file_path: p })}
              />
            </div>
            <button
              disabled={busy === 'fleet_documents'}
              onClick={() => {
                if (!docDraft.label.trim()) { setError('Say what the document is.'); return; }
                insertRow('fleet_documents', {
                  label: docDraft.label.trim(), expires_on: docDraft.expires_on || null,
                  file_path: docDraft.file_path,
                }, () => setDocDraft({ label: '', expires_on: '', file_path: null }));
              }}
              className={`mt-3 ${addBtn}`}
            >
              {busy === 'fleet_documents' ? 'Saving…' : 'Add document'}
            </button>
          </div>
        )}
        {docs.length === 0 ? (
          <p className="text-sm text-gray-500">No documents on this truck yet.</p>
        ) : (
          <div className="space-y-1.5">
            {docs.map((d) => (
              <div key={d.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                <span className="min-w-0">
                  <span className="font-medium">{d.label}</span>
                  {d.expires_on && (
                    <span className={`text-xs ml-2 ${expiryState(d.expires_on) === 'expired' ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                      expires {d.expires_on}{expiryState(d.expires_on) === 'expired' ? ' — expired' : ''}
                    </span>
                  )}
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  {d.file_path && (
                    <button onClick={() => openFile(d.file_path!)} className="text-xs text-brand-700 hover:underline">Open</button>
                  )}
                  {canDelete(d.created_by) && (
                    <button onClick={() => removeRow('fleet_documents', d.id)} disabled={busy === d.id} className="text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
