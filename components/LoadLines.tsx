'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { maybeCompressImage } from '@/lib/image-compress';
import {
  LOAD_STAMPS, totalLoadTons, countLoads, stampWindow,
  type WorkOrderLoad, type LoadStampKey,
} from '@/lib/work-orders';

// The sixteen load lines off the paper haul ticket: per load, the four in/out
// stamps, the BOL, the scale ticket number, and what it weighed.
//
// A stamp is one tap. The time is taken from the phone the instant the button
// is pressed and shown straight away — the GPS fix is chased afterwards with a
// short timeout and attached if it arrives. That ordering matters in the field:
// a driver in a pit with no sky should still get an accurate time, and waiting
// on a fix before showing anything makes the button feel broken.
//
// The BOL is a photo per load. When the AI key is set up, the photo is also
// read and the scale ticket # and tons fill themselves in; without it the
// photo is simply kept and the numbers are typed.
//
// The paper form is a 7-column grid, which is unusable on a phone, so each
// load is a card instead. Same information, one thumb.

export type LoadTotals = {
  loads: number;
  tons: number;
  // The day off the stamps — first tap and last tap.
  start: string | null;
  stop: string | null;
  signedOut: 'loaded' | 'empty' | null;
};

type Props = {
  workOrderId: string;
  locked?: boolean;
  // The ticket's date — where a typed-in time lands when the load has no
  // stamps yet to take the day from.
  jobDate?: string;
  onTotalsChange?: (totals: LoadTotals) => void;
};

const MAX_LOADS = 16;
const GPS_TIMEOUT_MS = 8000;
const BUCKET = 'work-tickets';

type Fix = { lat: number; lng: number; accuracy: number } | null;

// Best-effort location. Never rejects: a refused permission, a device with no
// GPS, or a slow fix all resolve to null so the stamp still saves.
function getFix(): Promise<Fix> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    let settled = false;
    const done = (v: Fix) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), GPS_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
          accuracy: Math.round(pos.coords.accuracy),
        });
      },
      () => { clearTimeout(timer); done(null); },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
    );
  });
}

const clockOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

const pad = (n: number) => String(n).padStart(2, '0');
// The phone's own calendar day and 24-hour clock for an instant — what a
// time box shows and takes.
function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localHHMM(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the photo.'));
    r.readAsDataURL(file);
  });
}

// Have the BOL read. Null on anything short of a clean answer — the photo is
// kept either way and the driver types what didn't come through. Tons outside
// a truckload's range are dropped rather than trusted.
async function readBol(file: File): Promise<{ ticket_number: string | null; tons: number | null } | null> {
  try {
    const image = await fileToBase64(file);
    const res = await fetch('/api/fleet/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bol', image, media_type: file.type || 'image/jpeg' }),
    });
    const json = await res.json();
    if (!json.ok) return null;
    const f = (json.fields || {}) as Record<string, string | number | null>;
    const tn = f.ticket_number == null ? null : String(f.ticket_number).trim() || null;
    const t = f.tons == null ? NaN : Number(f.tons);
    return {
      ticket_number: tn,
      tons: Number.isFinite(t) && t > 0 && t < 100 ? Math.round(t * 100) / 100 : null,
    };
  } catch {
    return null;
  }
}

// Where the floating stamp button sits, remembered per device. It's a
// per-driver convenience — a lost value just puts the button back in the
// corner.
const FAB_POS_KEY = 'stallion-stamp-fab-pos';

export default function LoadLines({ workOrderId, locked = false, jobDate, onTotalsChange }: Props) {
  const supabase = createClient();
  const [loads, setLoads] = useState<WorkOrderLoad[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Times shown before the row comes back from the database, so a tap reads as
  // instant even on a bad signal. Keyed "loadNo:stampKey".
  const [pending, setPending] = useState<Record<string, string>>({});
  // Loads whose times are being typed instead of tapped.
  const [editing, setEditing] = useState<Set<number>>(new Set());
  // The BOL photo flow: which load the camera was opened for, and what came
  // of the last read, per load.
  const bolInputRef = useRef<HTMLInputElement>(null);
  const bolTarget = useRef<number | null>(null);
  const [bolNote, setBolNote] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('work_order_loads')
      .select('*')
      .eq('work_order_id', workOrderId)
      .order('load_no');
    setLoads((data as WorkOrderLoad[]) || []);
    setLoading(false);
  }, [supabase, workOrderId]);

  // Nudge the ticket's pending deal at the funding app after a change lands.
  // Fire-and-forget: the stamp is already saved, and for tickets the funding
  // app doesn't care about this is a server-side no-op.
  const syncPending = useCallback(() => {
    fetch(`/api/work-orders/${workOrderId}/pending-sync`, { method: 'POST', keepalive: true })
      .catch(() => null);
  }, [workOrderId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const day = stampWindow(loads);
    onTotalsChange?.({
      loads: countLoads(loads),
      tons: totalLoadTons(loads),
      start: day.start,
      stop: day.stop,
      signedOut: day.signedOut,
    });
  }, [loads, onTotalsChange]);

  async function writeLoad(loadNo: number, patch: Record<string, unknown>) {
    const existing = loads.find((l) => l.load_no === loadNo);
    return existing
      ? supabase.from('work_order_loads').update(patch).eq('id', existing.id)
      : supabase.from('work_order_loads').insert({ work_order_id: workOrderId, load_no: loadNo, ...patch });
  }

  async function stamp(loadNo: number, key: LoadStampKey) {
    if (locked) return;
    const at = new Date().toISOString();
    const pk = `${loadNo}:${key}`;
    setPending((p) => ({ ...p, [pk]: at }));
    setBusy(pk); setError('');

    const fix = await getFix();
    const { error: err } = await writeLoad(loadNo, {
      [`${key}_at`]: at,
      [`${key}_lat`]: fix?.lat ?? null,
      [`${key}_lng`]: fix?.lng ?? null,
      [`${key}_accuracy`]: fix?.accuracy ?? null,
    });

    setBusy('');
    setPending((p) => { const n = { ...p }; delete n[pk]; return n; });
    if (err) { setError(err.message); return; }
    refresh();
    syncPending();
  }

  async function clearStamp(load: WorkOrderLoad, key: LoadStampKey) {
    if (locked) return;
    setBusy(`${load.load_no}:${key}`); setError('');
    const { error: err } = await supabase.from('work_order_loads').update({
      [`${key}_at`]: null,
      [`${key}_lat`]: null,
      [`${key}_lng`]: null,
      [`${key}_accuracy`]: null,
    }).eq('id', load.id);
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
    syncPending();
  }

  // A time typed in for a tap that was missed. It lands on the same day as
  // the load's other stamps (or the ticket's date), and carries no GPS fix —
  // which is exactly what the office sees: a typed time says "no fix".
  async function setTime(loadNo: number, key: LoadStampKey, hhmm: string) {
    if (locked) return;
    const existing = loads.find((l) => l.load_no === loadNo);
    const current = existing ? (existing[`${key}_at`] as string | null) : null;
    if (!hhmm) {
      if (existing && current) await clearStamp(existing, key);
      return;
    }
    if (current && localHHMM(current) === hhmm) return;
    const sibling = existing
      ? LOAD_STAMPS.map((s) => existing[`${s.key}_at`] as string | null).find(Boolean)
      : null;
    const anyStamp = loads
      .flatMap((l) => LOAD_STAMPS.map((s) => l[`${s.key}_at`] as string | null))
      .find(Boolean);
    const day = sibling ? localDate(sibling)
      : anyStamp ? localDate(anyStamp)
      : (jobDate || localDate(new Date().toISOString()));
    const at = new Date(`${day}T${hhmm}`);
    if (Number.isNaN(at.getTime())) return;

    setBusy(`${loadNo}:${key}`); setError('');
    const { error: err } = await writeLoad(loadNo, {
      [`${key}_at`]: at.toISOString(),
      [`${key}_lat`]: null,
      [`${key}_lng`]: null,
      [`${key}_accuracy`]: null,
    });
    setBusy('');
    if (err) { setError(err.message); return; }
    refresh();
    syncPending();
  }

  async function setField(loadNo: number, field: 'ticket_number' | 'tons', value: string) {
    const existing = loads.find((l) => l.load_no === loadNo);
    const val = value === '' ? null : (field === 'tons' ? Number(value) : value);
    if (existing && existing[field] === val) return;
    // Keep the field responsive while the write is in flight.
    setLoads((ls) => ls.map((l) => (l.load_no === loadNo ? { ...l, [field]: val } as WorkOrderLoad : l)));
    if (existing) {
      await supabase.from('work_order_loads').update({ [field]: val }).eq('id', existing.id);
    } else {
      await supabase.from('work_order_loads')
        .insert({ work_order_id: workOrderId, load_no: loadNo, [field]: val });
      refresh();
    }
    syncPending();
  }

  async function removeLoad(load: WorkOrderLoad) {
    if (locked) return;
    setBusy(`del${load.load_no}`);
    await supabase.from('work_order_loads').delete().eq('id', load.id);
    setBusy('');
    refresh();
    syncPending();
  }

  // ---- BOL photos -----------------------------------------------------------
  function pickBol(loadNo: number) {
    if (locked) return;
    bolTarget.current = loadNo;
    bolInputRef.current?.click();
  }

  async function onBolFile(file: File) {
    const loadNo = bolTarget.current;
    if (loadNo == null || locked) return;
    setBusy(`bol${loadNo}`); setError('');
    setBolNote((n) => ({ ...n, [loadNo]: '' }));
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You are signed out — sign in again.');
      const small = await maybeCompressImage(file);
      const ext = (small.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${user.id}/bol/${Date.now()}-load${loadNo}.${ext}`;

      // Saving the photo and reading it don't wait on each other.
      const [{ error: upErr }, read] = await Promise.all([
        supabase.storage.from(BUCKET).upload(path, small, { upsert: false }),
        small.type.startsWith('image/') ? readBol(small) : Promise.resolve(null),
      ]);
      if (upErr) throw upErr;

      const patch: Record<string, unknown> = { bol_path: path };
      if (read?.ticket_number) patch.ticket_number = read.ticket_number;
      if (read?.tons != null) patch.tons = read.tons;
      const { error: err } = await writeLoad(loadNo, patch);
      if (err) throw err;

      setBolNote((n) => ({
        ...n,
        [loadNo]: read && (read.ticket_number || read.tons != null)
          ? 'Read off the BOL ✓ — check the numbers.'
          : 'BOL saved — type the ticket # and tons.',
      }));
      await refresh();
      syncPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the BOL photo.');
    } finally {
      setBusy('');
      bolTarget.current = null;
      if (bolInputRef.current) bolInputRef.current.value = '';
    }
  }

  // A fresh signed link at tap time; the tab opens before the await because
  // Safari blocks a window.open that comes after one.
  async function openBol(path: string) {
    const tab = window.open('about:blank', '_blank');
    const { data, error: err } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
    if (err || !data?.signedUrl) {
      tab?.close();
      setError('Could not open that BOL — try again, or retake it.');
      return;
    }
    if (tab) tab.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  async function removeBol(load: WorkOrderLoad) {
    if (locked) return;
    await supabase.from('work_order_loads').update({ bol_path: null }).eq('id', load.id);
    setBolNote((n) => ({ ...n, [load.load_no]: '' }));
    refresh();
  }

  const nextNo = loads.length ? Math.max(...loads.map((l) => l.load_no)) + 1 : 1;
  // A blank row sits ready under the last one so the next load is always a
  // single tap away — no "add a row" step between loads.
  const showBlank = !locked && loads.length < MAX_LOADS;
  const tons = totalLoadTons(loads);
  const count = countLoads(loads);

  // ---- The floating stamp button ------------------------------------------
  // A driver mid-haul lives in the in/out cycle: load in → load out →
  // unload in → unload out → next load's in. After the first Load In on the
  // cards, this button floats over the page pre-armed with whichever stamp
  // comes next, so the whole day is the same thumb on the same spot. Hold and
  // drag to park it anywhere; the spot is remembered on the device.
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(null);
  const fabRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(FAB_POS_KEY);
      if (saved) {
        const p = JSON.parse(saved) as { x: number; y: number };
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) setFabPos(p);
      }
    } catch { /* corner default is fine */ }
  }, []);

  const stampKeys = LOAD_STAMPS.map((s) => s.key);
  const hasStamp = (l: WorkOrderLoad) => stampKeys.some((k) => l[`${k}_at` as keyof WorkOrderLoad]);

  // The next stamp in the cycle, walking the last load that has any time on
  // it. Null (no button) until the first Load In, and again once all sixteen
  // lines are done.
  function nextStamp(): { loadNo: number; key: LoadStampKey; label: string } | null {
    const stamped = [...loads].sort((a, b) => a.load_no - b.load_no).filter(hasStamp);
    if (stamped.length === 0) return null;
    const active = stamped[stamped.length - 1];
    for (const s of LOAD_STAMPS) {
      if (!active[`${s.key}_at` as keyof WorkOrderLoad]) {
        return { loadNo: active.load_no, key: s.key, label: s.label };
      }
    }
    if (active.load_no + 1 > MAX_LOADS) return null;
    return { loadNo: active.load_no + 1, key: 'load_in', label: 'Load in' };
  }
  const next = !locked && !loading ? nextStamp() : null;
  // The tile to light up on the cards: the FAB's next stamp, or — before the
  // day's first tap — Load in on the first load.
  const firstNo = loads.length ? Math.min(...loads.map((l) => l.load_no)) : 1;
  const lit = next
    ?? (!locked && !loading && !loads.some(hasStamp) ? { loadNo: firstNo, key: 'load_in' as LoadStampKey } : null);

  const clamp = (p: { x: number; y: number }) => {
    const w = fabRef.current?.offsetWidth ?? 140;
    const h = fabRef.current?.offsetHeight ?? 80;
    return {
      x: Math.min(Math.max(4, p.x), window.innerWidth - w - 4),
      y: Math.min(Math.max(4, p.y), window.innerHeight - h - 4),
    };
  };

  function fabPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = fabRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false };
  }
  function fabPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // A real drag, not a shaky thumb — below this it still counts as a tap.
    if (!d.moved && Math.hypot(dx, dy) < 8) return;
    d.moved = true;
    setFabPos(clamp({ x: d.origX + dx, y: d.origY + dy }));
  }
  function fabPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) {
      // Parked: remember the spot on this device.
      setFabPos((p) => {
        try { if (p) localStorage.setItem(FAB_POS_KEY, JSON.stringify(p)); } catch { /* fine */ }
        return p;
      });
    } else if (next && !busy) {
      stamp(next.loadNo, next.key);
    }
  }

  const input = 'w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm';

  function stampButton(loadNo: number, key: LoadStampKey, label: string, load?: WorkOrderLoad) {
    const pk = `${loadNo}:${key}`;
    const saved = load ? (load[`${key}_at`] as string | null) : null;
    const shown = pending[pk] || saved;
    const hasFix = load ? load[`${key}_lat` as keyof WorkOrderLoad] != null : false;
    const working = busy === pk;

    if (shown) {
      return (
        <button
          key={key}
          type="button"
          onClick={() => (load && !locked ? clearStamp(load, key) : undefined)}
          disabled={locked || working}
          title={locked ? undefined : 'Tap to clear'}
          className="flex flex-col items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 px-1 py-2 disabled:opacity-60"
        >
          <span className="text-[10px] uppercase tracking-wide text-emerald-800">{label}</span>
          <span className="text-sm font-semibold text-emerald-900 tabular-nums">
            {clockOf(shown)}
          </span>
          <span className="text-[10px] text-emerald-700">
            {working ? 'saving…' : hasFix ? '📍 located' : pending[pk] ? 'locating…' : 'no fix'}
          </span>
        </button>
      );
    }
    const isLit = !!lit && lit.loadNo === loadNo && lit.key === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => stamp(loadNo, key)}
        disabled={locked || working}
        className={`flex flex-col items-center justify-center rounded-md border-2 px-1 py-2 disabled:opacity-50 ${
          isLit
            ? 'border-amber-400 bg-amber-50 hover:bg-amber-100'
            : 'border-gray-200 bg-white hover:border-brand-700 hover:bg-gray-50 active:bg-gray-100'
        }`}
      >
        <span className={`text-[10px] uppercase tracking-wide ${isLit ? 'text-amber-900' : 'text-gray-500'}`}>{label}</span>
        <span className={`text-sm font-semibold ${isLit ? 'text-amber-900' : 'text-brand-700'}`}>Tap</span>
        <span className={`text-[10px] ${isLit ? 'text-amber-700' : 'text-gray-400'}`}>
          {working ? 'saving…' : isLit ? 'next' : '—'}
        </span>
      </button>
    );
  }

  function timeBoxes(loadNo: number, load?: WorkOrderLoad) {
    return (
      <div className="grid grid-cols-4 gap-1.5">
        {LOAD_STAMPS.map((s) => {
          const saved = load ? (load[`${s.key}_at`] as string | null) : null;
          return (
            <label key={s.key} className="block">
              <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 text-center">{s.label}</span>
              <input
                key={`${load?.id ?? `new${loadNo}`}-${s.key}-${saved ?? ''}`}
                type="time"
                defaultValue={localHHMM(saved)}
                disabled={locked || busy === `${loadNo}:${s.key}`}
                onBlur={(e) => setTime(loadNo, s.key, e.target.value)}
                className="w-full px-1 py-1.5 border border-gray-300 rounded-md text-xs tabular-nums"
              />
            </label>
          );
        })}
      </div>
    );
  }

  function loadCard(loadNo: number, load?: WorkOrderLoad) {
    const typing = editing.has(loadNo);
    const toggleTyping = () => setEditing((s) => {
      const n = new Set(s);
      if (n.has(loadNo)) n.delete(loadNo); else n.add(loadNo);
      return n;
    });
    const bolBusy = busy === `bol${loadNo}`;
    const firstStamp = load ? (load.load_in_at || null) : null;
    const lastStamp = load
      ? [...LOAD_STAMPS].reverse().map((s) => load[`${s.key}_at`] as string | null).find(Boolean) || null
      : null;
    const legHours = firstStamp && lastStamp && lastStamp !== firstStamp
      ? (new Date(lastStamp).getTime() - new Date(firstStamp).getTime()) / 3_600_000
      : null;

    return (
      <div key={loadNo} className={`rounded-lg border p-3 ${load ? 'border-gray-200 bg-white' : 'border-dashed border-gray-300 bg-gray-50'}`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-semibold">
            Load {loadNo}
            {legHours != null && legHours > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-500">{legHours.toFixed(2)} h in → out</span>
            )}
            {!load && !locked && (
              <span className="ml-2 text-xs font-normal text-gray-500">tap Load in at the pit</span>
            )}
          </span>
          {load && !locked && (
            <button
              type="button"
              onClick={() => removeLoad(load)}
              disabled={busy === `del${loadNo}`}
              className="text-xs text-red-600 hover:underline disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>

        {typing ? timeBoxes(loadNo, load) : (
          <div className="grid grid-cols-4 gap-1.5">
            {LOAD_STAMPS.map((s) => stampButton(loadNo, s.key, s.label, load))}
          </div>
        )}
        {!locked && (
          <div className="text-right mt-1">
            <button type="button" onClick={toggleTyping} className="text-[11px] text-brand-700 hover:underline">
              {typing ? '✓ Done typing times' : load ? '✎ Edit times' : '✎ Type the times instead'}
            </button>
          </div>
        )}

        <div className="grid grid-cols-[1fr_5rem_auto] gap-2 mt-1 items-end">
          <label>
            <span className="block text-[11px] text-gray-500 mb-0.5">Scale ticket / BOL #</span>
            <input
              key={`tn-${load?.id ?? `new${loadNo}`}-${load?.ticket_number ?? ''}`}
              defaultValue={load?.ticket_number || ''}
              onBlur={(e) => setField(loadNo, 'ticket_number', e.target.value.trim())}
              disabled={locked}
              className={input}
            />
          </label>
          <label>
            <span className="block text-[11px] text-gray-500 mb-0.5">Tons</span>
            <input
              key={`tons-${load?.id ?? `new${loadNo}`}-${load?.tons ?? ''}`}
              type="number" step="0.01" min="0" inputMode="decimal"
              defaultValue={load?.tons ?? ''}
              onBlur={(e) => setField(loadNo, 'tons', e.target.value.trim())}
              disabled={locked}
              className={input}
            />
          </label>
          <div>
            <span className="block text-[11px] text-gray-500 mb-0.5">BOL photo</span>
            {load?.bol_path ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => openBol(load.bol_path!)}
                  className="px-2 py-1.5 rounded-md border border-emerald-300 bg-emerald-50 text-xs font-semibold text-emerald-800"
                >
                  ✓ BOL
                </button>
                {!locked && (
                  <button
                    type="button"
                    onClick={() => removeBol(load)}
                    aria-label={`Remove the BOL photo for load ${loadNo}`}
                    className="px-1 text-xs text-gray-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => pickBol(loadNo)}
                disabled={locked || bolBusy}
                className="px-2 py-1.5 rounded-md border border-amber-300 bg-amber-50 text-xs font-semibold text-amber-900 whitespace-nowrap disabled:opacity-50"
              >
                {bolBusy ? 'Reading…' : '📷 BOL'}
              </button>
            )}
          </div>
        </div>
        {bolNote[loadNo] && <p className="text-[11px] text-emerald-700 mt-1">{bolNote[loadNo]}</p>}
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Loads</h2>
        <span className="text-sm text-gray-600">
          <strong>{count}</strong> {count === 1 ? 'load' : 'loads'} · <strong>{tons.toFixed(2)}</strong> tons
        </span>
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {/* One camera input serves every load's BOL button. */}
      <input
        ref={bolInputRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onBolFile(f); }}
      />

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-2">
          {loads.map((l) => loadCard(l.load_no, l))}
          {showBlank && loadCard(nextNo)}
          {loads.length >= MAX_LOADS && (
            <p className="text-xs text-gray-500">
              That&apos;s all sixteen lines — the same as the paper ticket. Start a
              second ticket for anything past this.
            </p>
          )}
        </div>
      )}

      {/* The floating next-stamp button. touch-none stops the page scrolling
          out from under a drag. */}
      {next && (
        <div
          ref={fabRef}
          onPointerDown={fabPointerDown}
          onPointerMove={fabPointerMove}
          onPointerUp={fabPointerUp}
          onPointerCancel={() => { dragRef.current = null; }}
          style={fabPos
            ? { left: fabPos.x, top: fabPos.y }
            : { right: 16, bottom: 90 }}
          className="fixed z-50 touch-none select-none cursor-grab active:cursor-grabbing"
        >
          <div className={`rounded-2xl shadow-xl border-2 px-5 py-3 text-center min-w-[132px] ${
            busy
              ? 'bg-gray-500 border-gray-500 text-white'
              : next.key.startsWith('load')
                ? 'bg-brand-700 border-brand-900 text-white'
                : 'bg-accent-400 border-accent-500 text-white'
          }`}>
            <span className="block text-[10px] uppercase tracking-wide opacity-80">
              Load {next.loadNo}
            </span>
            <span className="block text-lg font-bold leading-tight">
              {busy ? 'Saving…' : next.label}
            </span>
            <span className="block text-[9px] opacity-70 mt-0.5">
              tap to stamp · hold &amp; drag to move
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
