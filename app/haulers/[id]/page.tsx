'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import {
  LOAD_STATUS_LABEL, LOAD_STATUS_TONE, isFreeOn,
  type Hauler, type HaulerEquipment, type HaulerAvailability,
  type HaulerLoad, type LoadStatus,
} from '@/lib/haulers';

// One hauler, from the office's side: their details, the fleet they've put on
// file, what they've blocked out, and the loads dispatch has sent them.

const today = () => new Date().toISOString().slice(0, 10);

export default function HaulerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const [hauler, setHauler] = useState<Hauler | null>(null);
  const [fleet, setFleet] = useState<HaulerEquipment[]>([]);
  const [windows, setWindows] = useState<HaulerAvailability[]>([]);
  const [loads, setLoads] = useState<HaulerLoad[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Hauler>>({});
  const [offering, setOffering] = useState(false);
  const [load, setLoad] = useState({
    job_number: '', job_name: '', phase_code: '', equipment_type: '',
    job_date: today(), start_time: '', pickup: '', dropoff: '',
    rate: '', rate_unit: 'hour', notes: '', equipment_id: '',
  });

  const refresh = useCallback(async () => {
    const [{ data: h }, { data: e }, { data: a }, { data: l }] = await Promise.all([
      supabase.from('haulers').select('*').eq('id', params.id).maybeSingle(),
      supabase.from('hauler_equipment').select('*').eq('hauler_id', params.id).order('unit_number'),
      supabase.from('hauler_availability').select('*').eq('hauler_id', params.id).order('start_date'),
      supabase.from('hauler_loads').select('*').eq('hauler_id', params.id)
        .order('job_date', { ascending: false, nullsFirst: false }),
    ]);
    if (!h) { setError('That hauler no longer exists.'); return; }
    setHauler(h as Hauler);
    setForm(h as Hauler);
    setFleet((e as HaulerEquipment[]) || []);
    setWindows((a as HaulerAvailability[]) || []);
    setLoads((l as HaulerLoad[]) || []);
  }, [params.id, supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function saveHauler() {
    setBusy('hauler'); setError(''); setMsg('');
    const { error: err } = await supabase.from('haulers').update({
      name: (form.name || '').trim(),
      contact_name: form.contact_name || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      mc_number: form.mc_number || null,
      dot_number: form.dot_number || null,
      insurance_expires: form.insurance_expires || null,
      active: form.active ?? true,
      notes: form.notes || null,
    }).eq('id', params.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    setEditing(false); setMsg('Saved.');
    refresh();
  }

  async function offerLoad() {
    if (!load.job_number.trim() && !load.job_name.trim()) {
      setError('Give the load a job number or a name so the hauler knows what it is.');
      return;
    }
    setBusy('offer'); setError(''); setMsg('');
    try {
      const res = await fetch('/api/haulers/loads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hauler_id: params.id,
          job_number: load.job_number.trim(),
          job_name: load.job_name.trim(),
          phase_code: load.phase_code.trim(),
          equipment_type: load.equipment_type.trim(),
          job_date: load.job_date,
          start_time: load.start_time,
          pickup: load.pickup.trim(),
          dropoff: load.dropoff.trim(),
          rate: load.rate,
          rate_unit: load.rate_unit,
          notes: load.notes.trim(),
          equipment_id: load.equipment_id || null,
        }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not send the load.'); return; }
      setMsg('Load sent — the hauler has been notified.');
      setOffering(false);
      setLoad({ ...load, job_number: '', job_name: '', pickup: '', dropoff: '', notes: '' });
      refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy('');
    }
  }

  async function setLoadStatus(id: string, status: string) {
    setBusy(id); setError('');
    try {
      const res = await fetch(`/api/haulers/loads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not update the load.'); return; }
      refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy('');
    }
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const card = 'bg-white border border-gray-200 rounded-lg p-4';

  if (error && !hauler) return <p className="text-sm text-red-600">{error}</p>;
  if (!hauler) return <p className="text-sm text-gray-500">Loading…</p>;

  const freeToday = fleet.filter((u) => u.active && isFreeOn(windows, today(), u.id)).length;

  return (
    <div className="space-y-4">
      <Link href="/haulers" className="text-sm text-brand-700 hover:underline">← Haulers</Link>

      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">{hauler.name}</h1>
        <button onClick={() => setEditing((v) => !v)} className="text-sm text-brand-700 hover:underline">
          {editing ? 'Cancel' : 'Edit details'}
        </button>
      </div>

      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* ---- Company details ---- */}
      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Company</h2>
        {editing ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="sm:col-span-2"><span className={label}>Name</span>
                <input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Contact</span>
                <input value={form.contact_name || ''} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Phone</span>
                <input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Email</span>
                <input value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Address</span>
                <input value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} className={input} />
              </label>
              <label><span className={label}>MC #</span>
                <input value={form.mc_number || ''} onChange={(e) => setForm({ ...form, mc_number: e.target.value })} className={input} />
              </label>
              <label><span className={label}>DOT #</span>
                <input value={form.dot_number || ''} onChange={(e) => setForm({ ...form, dot_number: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Insurance expires</span>
                <input type="date" value={form.insurance_expires || ''} onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })} className={input} />
              </label>
              <label className="flex items-center gap-2 text-sm mt-5">
                <input type="checkbox" checked={form.active ?? true} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active
              </label>
              <label className="sm:col-span-2"><span className={label}>Notes</span>
                <textarea value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={input} />
              </label>
            </div>
            <button
              onClick={saveHauler}
              disabled={busy === 'hauler'}
              className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
            >
              {busy === 'hauler' ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
            {([
              ['Contact', hauler.contact_name],
              ['Phone', hauler.phone],
              ['Email', hauler.email],
              ['Address', hauler.address],
              ['MC #', hauler.mc_number],
              ['DOT #', hauler.dot_number],
              ['Insurance expires', hauler.insurance_expires],
              ['Status', hauler.active ? 'Active' : 'Inactive'],
            ] as [string, string | null][])
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-gray-500">{k}</dt>
                  <dd className={k === 'Insurance expires' && v! < today() ? 'text-red-600 font-medium' : ''}>
                    {v}
                    {k === 'Insurance expires' && v! < today() ? ' — expired' : ''}
                  </dd>
                </div>
              ))}
          </dl>
        )}
      </div>

      {/* ---- Fleet ---- */}
      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
          Fleet — {fleet.filter((u) => u.active).length} active, {freeToday} free today
        </h2>
        {fleet.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing on file. The hauler adds their own trucks and equipment from their dashboard.
          </p>
        ) : (
          <div className="space-y-1.5">
            {fleet.map((u) => {
              const free = isFreeOn(windows, today(), u.id);
              return (
                <div key={u.id} className="flex justify-between items-center gap-3 text-sm border-b border-gray-100 last:border-0 pb-1.5 last:pb-0">
                  <span className="min-w-0">
                    <span className="font-medium">{u.unit_number || 'Unit'}</span>
                    <span className="text-gray-500"> · {[u.equipment_type, u.capacity, u.description].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${
                    !u.active ? 'bg-gray-100 text-gray-600 border-gray-200'
                    : free ? 'bg-emerald-100 text-emerald-900 border-emerald-200'
                    : 'bg-red-100 text-red-800 border-red-200'
                  }`}>
                    {!u.active ? 'Inactive' : free ? 'Free today' : 'Blocked today'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Availability ---- */}
      <div className={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Availability</h2>
        {windows.length === 0 ? (
          <p className="text-sm text-gray-500">No blocked-out dates on file.</p>
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
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${
                    w.status === 'blocked'
                      ? 'bg-red-100 text-red-800 border-red-200'
                      : 'bg-emerald-100 text-emerald-900 border-emerald-200'
                  }`}>
                    {w.status === 'blocked' ? 'Blocked' : 'Available'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Loads ---- */}
      <div className={card}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Loads</h2>
          <button onClick={() => setOffering((v) => !v)} className="text-sm text-brand-700 hover:underline">
            {offering ? 'Cancel' : 'Send a load'}
          </button>
        </div>

        {offering && (
          <div className="border border-gray-200 rounded-md p-3 mb-4 bg-gray-50">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <label><span className={label}>Job #</span>
                <input value={load.job_number} onChange={(e) => setLoad({ ...load, job_number: e.target.value })} className={input} />
              </label>
              <label className="col-span-1 sm:col-span-2"><span className={label}>Job name</span>
                <input value={load.job_name} onChange={(e) => setLoad({ ...load, job_name: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Phase code</span>
                <input value={load.phase_code} onChange={(e) => setLoad({ ...load, phase_code: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Date</span>
                <input type="date" value={load.job_date} onChange={(e) => setLoad({ ...load, job_date: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Start time</span>
                <input type="time" value={load.start_time} onChange={(e) => setLoad({ ...load, start_time: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Pickup</span>
                <input value={load.pickup} onChange={(e) => setLoad({ ...load, pickup: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Drop off</span>
                <input value={load.dropoff} onChange={(e) => setLoad({ ...load, dropoff: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Equipment needed</span>
                <input value={load.equipment_type} onChange={(e) => setLoad({ ...load, equipment_type: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Rate</span>
                <input type="number" step="0.01" min="0" inputMode="decimal" value={load.rate} onChange={(e) => setLoad({ ...load, rate: e.target.value })} className={input} />
              </label>
              <label><span className={label}>Per</span>
                <select value={load.rate_unit} onChange={(e) => setLoad({ ...load, rate_unit: e.target.value })} className={input}>
                  {['hour', 'ton', 'load', 'day'].map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <label><span className={label}>Unit (optional)</span>
                <select value={load.equipment_id} onChange={(e) => setLoad({ ...load, equipment_id: e.target.value })} className={input}>
                  <option value="">— Hauler picks —</option>
                  {fleet.filter((u) => u.active).map((u) => (
                    <option key={u.id} value={u.id}>{u.unit_number || u.equipment_type || 'Unit'}</option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 sm:col-span-3"><span className={label}>Notes</span>
                <textarea value={load.notes} onChange={(e) => setLoad({ ...load, notes: e.target.value })} rows={2} className={input} />
              </label>
            </div>
            <button
              onClick={offerLoad}
              disabled={busy === 'offer'}
              className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
            >
              {busy === 'offer' ? 'Sending…' : 'Send load'}
            </button>
          </div>
        )}

        {loads.length === 0 ? (
          <p className="text-sm text-gray-500">No loads sent to this hauler yet.</p>
        ) : (
          <div className="space-y-2">
            {loads.map((l) => {
              const unit = fleet.find((u) => u.id === l.equipment_id);
              return (
                <div key={l.id} className="border border-gray-200 rounded-md px-3 py-2">
                  <div className="flex justify-between items-start gap-3 flex-wrap">
                    <div className="min-w-0">
                      <span className="font-medium text-sm">
                        {l.job_number ? `Job ${l.job_number}` : l.job_name || 'Load'}
                      </span>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {[
                          l.job_number && l.job_name ? l.job_name : null,
                          l.job_date,
                          l.start_time,
                          unit ? `Unit ${unit.unit_number || ''}`.trim() : l.equipment_type,
                          l.pickup && l.dropoff ? `${l.pickup} → ${l.dropoff}` : (l.pickup || l.dropoff),
                          l.rate != null ? `$${Number(l.rate).toFixed(2)}/${l.rate_unit || 'hr'}` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                      {l.decline_reason && (
                        <div className="text-xs text-red-600 mt-0.5">Declined: {l.decline_reason}</div>
                      )}
                    </div>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${LOAD_STATUS_TONE[l.status as LoadStatus]}`}>
                      {LOAD_STATUS_LABEL[l.status as LoadStatus]}
                    </span>
                  </div>
                  {['offered', 'accepted', 'assigned'].includes(l.status) && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      {l.status === 'accepted' && (
                        <button onClick={() => setLoadStatus(l.id, 'assigned')} disabled={busy === l.id}
                          className="px-2.5 py-1 text-xs rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50">
                          Confirm assignment
                        </button>
                      )}
                      {l.status === 'assigned' && (
                        <button onClick={() => setLoadStatus(l.id, 'completed')} disabled={busy === l.id}
                          className="px-2.5 py-1 text-xs rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50">
                          Mark complete
                        </button>
                      )}
                      <button onClick={() => setLoadStatus(l.id, 'cancelled')} disabled={busy === l.id}
                        className="px-2.5 py-1 text-xs rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
