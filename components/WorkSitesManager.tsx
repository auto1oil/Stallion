'use client';
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { createClient } from '@/lib/supabase-browser';

// Map picker is client-only (Leaflet touches window) — load it on demand.
const SitePinPicker = dynamic(() => import('./SitePinPicker'), { ssr: false });

// Admin manager for geofence work sites: name + coordinates + radius. Stand at
// the site and tap "Use current location" to set its coordinates.

type Site = { id: string; name: string; lat: number; lng: number; radius_m: number; active: boolean };

export default function WorkSitesManager() {
  const supabase = createClient();
  const [sites, setSites] = useState<Site[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('150');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [locBusy, setLocBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);

  // Editing an existing site's location (re-drop the pin).
  const [editId, setEditId] = useState<string | null>(null);
  const [eLat, setELat] = useState('');
  const [eLng, setELng] = useState('');
  const [eShowMap, setEShowMap] = useState(false);
  const [eLocBusy, setELocBusy] = useState(false);
  const [eBusy, setEBusy] = useState(false);
  const [eErr, setEErr] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase.from('work_sites').select('id, name, lat, lng, radius_m, active').order('name');
    setSites((data as Site[]) || []);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  function useMyLocation() {
    setLocBusy(true); setErr('');
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { setErr('Location not available.'); setLocBusy(false); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); setLocBusy(false); },
      () => { setErr('Could not get location — allow it or enter coordinates manually.'); setLocBusy(false); },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  async function add() {
    setErr('');
    const la = parseFloat(lat), lo = parseFloat(lng), r = parseInt(radius, 10);
    if (!name.trim()) { setErr('Name the site.'); return; }
    if (!Number.isFinite(la) || !Number.isFinite(lo)) { setErr('Set the location (use current location or enter coordinates).'); return; }
    if (!Number.isFinite(r) || r <= 0) { setErr('Radius must be a positive number of meters.'); return; }
    setBusy(true);
    const { error } = await supabase.from('work_sites').insert({ name: name.trim(), lat: la, lng: lo, radius_m: r });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setName(''); setLat(''); setLng(''); setRadius('150');
    load();
  }

  async function updateRadius(id: string, r: number) {
    await supabase.from('work_sites').update({ radius_m: r }).eq('id', id);
    load();
  }
  function startEditLoc(s: Site) {
    setEditId(s.id); setELat(String(s.lat)); setELng(String(s.lng)); setEShowMap(false); setEErr('');
  }
  function useMyLocationEdit() {
    setELocBusy(true); setEErr('');
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { setEErr('Location not available.'); setELocBusy(false); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setELat(p.coords.latitude.toFixed(6)); setELng(p.coords.longitude.toFixed(6)); setELocBusy(false); },
      () => { setEErr('Could not get location — allow it or enter coordinates manually.'); setELocBusy(false); },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }
  async function saveLoc(id: string) {
    const la = parseFloat(eLat), lo = parseFloat(eLng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) { setEErr('Set a valid location (use current location, pick on map, or enter coordinates).'); return; }
    setEBusy(true);
    const { error } = await supabase.from('work_sites').update({ lat: la, lng: lo }).eq('id', id);
    setEBusy(false);
    if (error) { setEErr(error.message); return; }
    setEditId(null);
    load();
  }
  async function toggleActive(id: string, active: boolean) {
    await supabase.from('work_sites').update({ active }).eq('id', id);
    load();
  }
  async function remove(id: string) {
    if (!confirm('Delete this work site?')) return;
    await supabase.from('work_sites').delete().eq('id', id);
    load();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg mb-4">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-sm">Work sites &amp; geofence ({sites.length})</span>
        <span className="text-xs text-brand-700">{open ? 'Hide' : 'Manage'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 space-y-3">
          {sites.length === 0 && <p className="text-xs text-gray-400 pt-2">No sites yet. Add your shop/yard below.</p>}
          {sites.map((s) => (
            <div key={s.id} className="border-b border-gray-100 pb-2 space-y-2">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-medium">{s.name}</span>
                <label className="text-xs text-gray-500 flex items-center gap-1">radius
                  <input type="number" defaultValue={s.radius_m}
                    onBlur={(e) => updateRadius(s.id, parseInt(e.target.value, 10) || s.radius_m)}
                    className="w-16 border rounded px-1 py-0.5 text-xs text-right" /> m
                </label>
                <a href={`https://maps.google.com/?q=${s.lat},${s.lng}`} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 underline">map</a>
                <button onClick={() => (editId === s.id ? setEditId(null) : startEditLoc(s))} className="text-xs text-brand-700 hover:underline">
                  {editId === s.id ? 'close' : 'edit location'}
                </button>
                <label className="text-xs text-gray-500 flex items-center gap-1 ml-auto">
                  <input type="checkbox" checked={s.active} onChange={(e) => toggleActive(s.id, e.target.checked)} /> active
                </label>
                <button onClick={() => remove(s.id)} className="text-xs text-red-600 hover:underline">delete</button>
              </div>

              {editId === s.id && (
                <div className="rounded-md bg-gray-50 border border-gray-200 p-2 space-y-2">
                  <div className="flex gap-2 flex-wrap items-end">
                    <button type="button" onClick={() => setEShowMap((v) => !v)} className="px-2.5 py-1 text-xs rounded-md bg-brand-700 text-white hover:bg-brand-900 font-medium">
                      🗺️ {eShowMap ? 'Hide map' : 'Pick on map'}
                    </button>
                    <button type="button" onClick={useMyLocationEdit} disabled={eLocBusy} className="px-2.5 py-1 text-xs rounded-md border border-brand-700 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
                      {eLocBusy ? 'Locating…' : '📍 Use current location'}
                    </button>
                    <label className="text-xs text-gray-500 flex flex-col">Lat
                      <input value={eLat} onChange={(e) => setELat(e.target.value)} className="w-28 border rounded px-1 py-0.5 text-xs" /></label>
                    <label className="text-xs text-gray-500 flex flex-col">Lng
                      <input value={eLng} onChange={(e) => setELng(e.target.value)} className="w-28 border rounded px-1 py-0.5 text-xs" /></label>
                  </div>
                  {eShowMap && (
                    <SitePinPicker
                      lat={Number.isFinite(parseFloat(eLat)) ? parseFloat(eLat) : null}
                      lng={Number.isFinite(parseFloat(eLng)) ? parseFloat(eLng) : null}
                      radius={s.radius_m}
                      onPick={(la, lo) => { setELat(la.toFixed(6)); setELng(lo.toFixed(6)); }}
                    />
                  )}
                  {eErr && <p className="text-xs text-red-600">{eErr}</p>}
                  <div className="flex gap-2">
                    <button onClick={() => saveLoc(s.id)} disabled={eBusy} className="px-3 py-1 text-xs rounded-md bg-brand-700 text-white hover:bg-brand-900 disabled:opacity-50 font-medium">
                      {eBusy ? 'Saving…' : 'Save location'}
                    </button>
                    <button onClick={() => setEditId(null)} className="px-3 py-1 text-xs rounded-md border border-gray-300 hover:bg-gray-100">Cancel</button>
                  </div>
                  <p className="text-[11px] text-gray-400">Stand at the site and tap <span className="font-medium">Use current location</span>, or drop the pin on the map, then Save.</p>
                </div>
              )}
            </div>
          ))}
          <div className="pt-1 space-y-2">
            <div className="text-xs font-semibold text-gray-600">Add a site</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name (e.g. Main shop)" className="w-full border rounded px-2 py-1.5 text-sm" />
            <div className="flex gap-2 flex-wrap items-end">
              <button type="button" onClick={() => setShowMap((v) => !v)} className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white hover:bg-brand-900 font-medium">
                🗺️ {showMap ? 'Hide map' : 'Pick on map'}
              </button>
              <button type="button" onClick={useMyLocation} disabled={locBusy} className="px-3 py-1.5 text-sm rounded-md border border-brand-700 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
                {locBusy ? 'Locating…' : '📍 Use current location'}
              </button>
              <label className="text-xs text-gray-500 flex flex-col">Lat
                <input value={lat} onChange={(e) => setLat(e.target.value)} className="w-28 border rounded px-1 py-0.5 text-xs" /></label>
              <label className="text-xs text-gray-500 flex flex-col">Lng
                <input value={lng} onChange={(e) => setLng(e.target.value)} className="w-28 border rounded px-1 py-0.5 text-xs" /></label>
              <label className="text-xs text-gray-500 flex flex-col">Radius (m)
                <input value={radius} onChange={(e) => setRadius(e.target.value)} className="w-20 border rounded px-1 py-0.5 text-xs" /></label>
            </div>
            {showMap && (
              <SitePinPicker
                lat={Number.isFinite(parseFloat(lat)) ? parseFloat(lat) : null}
                lng={Number.isFinite(parseFloat(lng)) ? parseFloat(lng) : null}
                radius={parseInt(radius, 10) || 150}
                onPick={(la, lo) => { setLat(la.toFixed(6)); setLng(lo.toFixed(6)); }}
              />
            )}
            {err && <p className="text-xs text-red-600">{err}</p>}
            <button onClick={add} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white hover:bg-brand-900 disabled:opacity-50 font-medium">
              {busy ? 'Adding…' : 'Add site'}
            </button>
            <p className="text-[11px] text-gray-400">Tap <span className="font-medium">Pick on map</span> and drop a pin on each site (search an address to jump there). Radius is how close (meters) an employee must be to clock in.</p>
          </div>
        </div>
      )}
    </div>
  );
}
