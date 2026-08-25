'use client';
import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  LOAD_STAMPS, totalLoadTons, countLoads,
  type WorkOrderLoad, type LoadStampKey,
} from '@/lib/work-orders';

// The sixteen load lines off the paper haul ticket: per load, a ticket number,
// the four in/out stamps, and what it weighed.
//
// A stamp is one tap. The time is taken from the phone the instant the button
// is pressed and shown straight away — the GPS fix is chased afterwards with a
// short timeout and attached if it arrives. That ordering matters in the field:
// a driver in a pit with no sky should still get an accurate time, and waiting
// on a fix before showing anything makes the button feel broken.
//
// The paper form is a 7-column grid, which is unusable on a phone, so each
// load is a card instead. Same information, one thumb.

type Props = {
  workOrderId: string;
  locked?: boolean;
  onTotalsChange?: (totals: { loads: number; tons: number }) => void;
};

const MAX_LOADS = 16;
const GPS_TIMEOUT_MS = 8000;

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
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export default function LoadLines({ workOrderId, locked = false, onTotalsChange }: Props) {
  const supabase = createClient();
  const [loads, setLoads] = useState<WorkOrderLoad[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Times shown before the row comes back from the database, so a tap reads as
  // instant even on a bad signal. Keyed "loadNo:stampKey".
  const [pending, setPending] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('work_order_loads')
      .select('*')
      .eq('work_order_id', workOrderId)
      .order('load_no');
    setLoads((data as WorkOrderLoad[]) || []);
    setLoading(false);
  }, [supabase, workOrderId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    onTotalsChange?.({ loads: countLoads(loads), tons: totalLoadTons(loads) });
  }, [loads, onTotalsChange]);

  async function stamp(loadNo: number, key: LoadStampKey) {
    if (locked) return;
    const at = new Date().toISOString();
    const pk = `${loadNo}:${key}`;
    setPending((p) => ({ ...p, [pk]: at }));
    setBusy(pk); setError('');

    const fix = await getFix();
    const patch: Record<string, unknown> = {
      [`${key}_at`]: at,
      [`${key}_lat`]: fix?.lat ?? null,
      [`${key}_lng`]: fix?.lng ?? null,
      [`${key}_accuracy`]: fix?.accuracy ?? null,
    };

    const existing = loads.find((l) => l.load_no === loadNo);
    const { error: err } = existing
      ? await supabase.from('work_order_loads').update(patch).eq('id', existing.id)
      : await supabase.from('work_order_loads')
          .insert({ work_order_id: workOrderId, load_no: loadNo, ...patch });

    setBusy('');
    setPending((p) => { const n = { ...p }; delete n[pk]; return n; });
    if (err) { setError(err.message); return; }
    refresh();
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
  }

  async function setField(loadNo: number, field: 'ticket_number' | 'tons', value: string) {
    const existing = loads.find((l) => l.load_no === loadNo);
    const val = value === '' ? null : (field === 'tons' ? Number(value) : value);
    // Keep the field responsive while the write is in flight.
    setLoads((ls) => ls.map((l) => (l.load_no === loadNo ? { ...l, [field]: val } as WorkOrderLoad : l)));
    if (existing) {
      await supabase.from('work_order_loads').update({ [field]: val }).eq('id', existing.id);
    } else {
      await supabase.from('work_order_loads')
        .insert({ work_order_id: workOrderId, load_no: loadNo, [field]: val });
      refresh();
    }
  }

  async function removeLoad(load: WorkOrderLoad) {
    if (locked) return;
    setBusy(`del${load.load_no}`);
    await supabase.from('work_order_loads').delete().eq('id', load.id);
    setBusy('');
    refresh();
  }

  const nextNo = loads.length ? Math.max(...loads.map((l) => l.load_no)) + 1 : 1;
  // A blank row sits ready under the last one so the next load is always a
  // single tap away — no "add a row" step between loads.
  const showBlank = !locked && loads.length < MAX_LOADS;
  const tons = totalLoadTons(loads);
  const count = countLoads(loads);

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
          className="flex flex-col items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 px-2 py-2 disabled:opacity-60"
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
    return (
      <button
        key={key}
        type="button"
        onClick={() => stamp(loadNo, key)}
        disabled={locked || working}
        className="flex flex-col items-center justify-center rounded-md border border-gray-300 bg-white px-2 py-2 hover:border-brand-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
        <span className="text-sm font-semibold text-brand-700">Tap</span>
        <span className="text-[10px] text-gray-400">{working ? 'saving…' : '—'}</span>
      </button>
    );
  }

  function loadCard(loadNo: number, load?: WorkOrderLoad) {
    return (
      <div key={loadNo} className={`rounded-lg border p-3 ${load ? 'border-gray-200 bg-white' : 'border-dashed border-gray-300 bg-gray-50'}`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-semibold">
            Load {loadNo}
            {!load && <span className="ml-2 text-xs font-normal text-gray-500">tap a time to start it</span>}
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

        <div className="grid grid-cols-4 gap-1.5">
          {LOAD_STAMPS.map((s) => stampButton(loadNo, s.key, s.label, load))}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <label>
            <span className="block text-[11px] text-gray-500 mb-0.5">Scale ticket #</span>
            <input
              defaultValue={load?.ticket_number || ''}
              onBlur={(e) => setField(loadNo, 'ticket_number', e.target.value.trim())}
              disabled={locked}
              className={input}
            />
          </label>
          <label>
            <span className="block text-[11px] text-gray-500 mb-0.5">Tons</span>
            <input
              type="number" step="0.01" min="0" inputMode="decimal"
              defaultValue={load?.tons ?? ''}
              onBlur={(e) => setField(loadNo, 'tons', e.target.value.trim())}
              disabled={locked}
              className={input}
            />
          </label>
        </div>
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
    </div>
  );
}
