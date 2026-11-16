// ============================================================================
// Route miles by state — the IFTA math.
// ============================================================================
// Google's Routes API gives us the drive (distance + the route's polyline);
// everything after that is ours: the polyline is decoded into points, each
// little stretch of road is assigned to the state it sits in (tested against
// bundled Census state boundaries), and the miles add up per state. One
// Google call per trip — 10,000 a month are free, half a cent after — and
// zero calls for the state split.

import statesTopo from 'us-atlas/states-10m.json';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from 'geojson';

// ---- State boundaries ------------------------------------------------------

const FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR',
};

type StateShape = { usps: string; polygons: [number, number][][][] };

let STATES: StateShape[] | null = null;

function loadStates(): StateShape[] {
  if (STATES) return STATES;
  const topo = statesTopo as unknown as Topology;
  const collection = feature(
    topo,
    topo.objects.states as GeometryCollection,
  ) as unknown as FeatureCollection<Geometry>;
  STATES = collection.features
    .map((f: Feature<Geometry>) => {
      const usps = FIPS_TO_USPS[String(f.id).padStart(2, '0')];
      if (!usps || !f.geometry) return null;
      const g = f.geometry;
      const polygons =
        g.type === 'Polygon' ? [(g as Polygon).coordinates]
        : g.type === 'MultiPolygon' ? (g as MultiPolygon).coordinates
        : [];
      return { usps, polygons: polygons as [number, number][][][] };
    })
    .filter((s): s is StateShape => s !== null);
  return STATES;
}

// Even-odd ray casting across every ring of a polygon, so holes count out.
function inPolygon(lng: number, lat: number, rings: [number, number][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export function stateAt(lat: number, lng: number): string | null {
  for (const s of loadStates()) {
    for (const poly of s.polygons) {
      if (inPolygon(lng, lat, poly)) return s.usps;
    }
  }
  return null;
}

// ---- Polyline + distance ---------------------------------------------------

// Google's encoded polyline algorithm, precision 1e-5.
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function haversineMiles(a: [number, number], b: [number, number]): number {
  const R = 3958.761; // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Each stretch of the route goes to the state its midpoint is in. Long
// stretches are subdivided so a segment that crosses a line near its middle
// doesn't dump all its miles on one side.
export function milesByState(points: [number, number][]): { state: string; miles: number }[] {
  const acc = new Map<string, number>();
  const MAX_STEP = 2; // miles
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversineMiles(a, b);
    if (d === 0) continue;
    const steps = Math.max(1, Math.ceil(d / MAX_STEP));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const mid: [number, number] = [
        a[0] + (b[0] - a[0]) * ((t0 + t1) / 2),
        a[1] + (b[1] - a[1]) * ((t0 + t1) / 2),
      ];
      const st = stateAt(mid[0], mid[1]) || '??';
      acc.set(st, (acc.get(st) || 0) + d / steps);
    }
  }
  return Array.from(acc.entries())
    .map(([state, miles]) => ({ state, miles: Math.round(miles * 10) / 10 }))
    .filter((r) => r.miles > 0)
    .sort((a, b) => b.miles - a.miles);
}

// ---- The Google call -------------------------------------------------------

export async function computeRouteMiles(
  apiKey: string,
  from: string,
  to: string,
): Promise<{ totalMiles: number; rows: { state: string; miles: number }[] }> {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Routes API requires a field mask — ask for exactly what the split needs.
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { address: from },
      destination: { address: to },
      travelMode: 'DRIVE',
    }),
    signal: AbortSignal.timeout(15000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    routes?: { distanceMeters?: number; polyline?: { encodedPolyline?: string } }[];
    error?: { message?: string; status?: string };
  };

  if (!res.ok) {
    const msg = json.error?.message || `Google answered ${res.status}`;
    if (res.status === 403 || json.error?.status === 'PERMISSION_DENIED') {
      throw new Error('Google rejected the Maps key — check it under Work Orders → Setup, and that the Routes API is enabled on it.');
    }
    throw new Error(`Could not get the route: ${msg}`);
  }

  const route = json.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!route || !encoded) {
    throw new Error('Google could not find a drivable route between those two places — check the spelling, or add the city and state.');
  }

  const points = decodePolyline(encoded);
  const rows = milesByState(points);
  // The polyline's point-to-point sum runs a hair under the road distance;
  // scale the split so it adds up to what Google says the drive really is.
  const splitTotal = rows.reduce((n, r) => n + r.miles, 0);
  const totalMiles = Math.round(((route.distanceMeters || 0) / 1609.344) * 10) / 10;
  const scale = splitTotal > 0 && totalMiles > 0 ? totalMiles / splitTotal : 1;
  const scaled = rows.map((r) => ({ state: r.state, miles: Math.round(r.miles * scale * 10) / 10 }));
  return { totalMiles, rows: scaled };
}
