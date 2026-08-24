'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

// Interactive map for placing a work site: tap the map to drop the pin, or
// search an address to jump there first. Uses OpenStreetMap tiles (no API key).
// Renders a circle for the geofence radius so the admin sees the coverage.

type LMap = { setView: (c: [number, number], z?: number) => void; on: (e: string, cb: (ev: { latlng: { lat: number; lng: number } }) => void) => void; remove: () => void; invalidateSize: () => void };
type LLayer = { setLatLng: (c: [number, number]) => void; setRadius: (r: number) => void; addTo: (m: LMap) => LLayer };

export default function SitePinPicker({ lat, lng, radius, onPick }: {
  lat: number | null; lng: number | null; radius: number;
  onPick: (lat: number, lng: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const markerRef = useRef<LLayer | null>(null);
  const circleRef = useRef<LLayer | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = ((await import('leaflet')) as any).default;
      if (cancelled || !ref.current || mapRef.current) return;
      const start: [number, number] = lat != null && lng != null ? [lat, lng] : [40.3916, -111.8508]; // Lehi, UT
      const map = L.map(ref.current).setView(start, lat != null ? 16 : 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      mapRef.current = map;
      const place = (la: number, lo: number) => {
        if (markerRef.current) markerRef.current.setLatLng([la, lo]);
        else markerRef.current = L.circleMarker([la, lo], { radius: 7, color: '#B45309', fillColor: '#B45309', fillOpacity: 1 }).addTo(map);
        if (circleRef.current) { circleRef.current.setLatLng([la, lo]); circleRef.current.setRadius(radius); }
        else circleRef.current = L.circle([la, lo], { radius, color: '#B45309', fillOpacity: 0.1 }).addTo(map);
      };
      if (lat != null && lng != null) place(lat, lng);
      map.on('click', (e) => { place(e.latlng.lat, e.latlng.lng); onPick(e.latlng.lat, e.latlng.lng); });
      setTimeout(() => map.invalidateSize(), 120);
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) mapRef.current.remove();
      mapRef.current = null; markerRef.current = null; circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the radius circle in sync with the radius input.
  useEffect(() => { if (circleRef.current) circleRef.current.setRadius(radius); }, [radius]);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
      const j = await res.json();
      if (j[0] && mapRef.current) {
        const la = parseFloat(j[0].lat), lo = parseFloat(j[0].lon);
        mapRef.current.setView([la, lo], 16);
        if (markerRef.current) markerRef.current.setLatLng([la, lo]);
        if (circleRef.current) circleRef.current.setLatLng([la, lo]);
        onPick(la, lo);
      }
    } catch { /* ignore */ }
    setSearching(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
          placeholder="Search an address / place…" className="flex-1 border rounded px-2 py-1.5 text-sm" />
        <button type="button" onClick={search} disabled={searching}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
          {searching ? '…' : 'Find'}
        </button>
      </div>
      <div ref={ref} className="w-full h-64 rounded-md border border-gray-200 relative z-0" />
      <p className="text-[11px] text-gray-400">Tap the map to drop the pin. The shaded circle is the clock-in radius.</p>
    </div>
  );
}
