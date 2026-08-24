'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import WorkSitesManager from '@/components/WorkSitesManager';
import SelfClock from '@/components/SelfClock';
import { fmtClock, dayKey, todayKey, isoToMountainInput, mountainInputToIso, tzAbbrev } from '@/lib/timeclock-tz';

type HoursEntry = {
  id: string;
  employee_id: string;
  employee_name: string;
  date: string;
  hours: number;
  notes: string | null;
  // For time-clock entries.
  is_clock?: boolean;
  session_count?: number;
  // Actual clock-in/out pairs for the day (time-clock entries only).
  clock_sessions?: { in: string; out: string | null; inTz?: string | null; outTz?: string | null }[];
};

type ClockSession = {
  id: string; employee_id: string; clock_in_at: string; clock_out_at: string | null;
  clock_in_site_id?: string | null; clock_out_site_id?: string | null;
  clock_in_lat?: number | null; clock_out_lat?: number | null;
  clock_in_tz?: string | null; clock_out_tz?: string | null;
};

type Person = {
  id: string;
  full_name: string | null;
  email: string;
  role: 'driver' | 'office' | 'contractor' | 'funder' | 'mechanic' | 'labor' | 'admin' | 'master_admin';
  remote_clock?: boolean | null;
};

function weekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d;
}

function weekKey(d: Date): string {
  const ws = weekStart(d);
  return `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, '0')}-${String(ws.getDate()).padStart(2, '0')}`;
}

function weekLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

function weekRange(key: string): { start: string; end: string } {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 7);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
}

// "1h 23m" since a clock-in time.
function elapsed(fromIso: string, nowMs: number): string {
  const ms = nowMs - new Date(fromIso).getTime();
  if (ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}
// datetime-local <-> ISO, both interpreted in Mountain time so an admin edits a
// session in the same zone the clock runs on, regardless of their own device.
const isoToLocalInput = isoToMountainInput;
const localInputToIso = mountainInputToIso;

type Ping = { id: number; session_id: string; employee_id: string; lat: number; lng: number; accuracy_m: number | null; recorded_at: string };

// A single point on Google Maps (live "where are they now").
function mapsPointUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
// A Google Maps directions URL stringing the breadcrumb points into a path.
// Sampled to <=10 points (URL waypoint limit), preserving order + first/last.
function mapsPathUrl(points: { lat: number; lng: number }[]): string {
  if (points.length === 0) return '';
  let pts = points;
  if (points.length > 10) {
    const step = (points.length - 1) / 9;
    pts = Array.from({ length: 10 }, (_, i) => points[Math.round(i * step)]);
  }
  return 'https://www.google.com/maps/dir/' + pts.map((p) => `${p.lat},${p.lng}`).join('/');
}

type ReqRow = {
  id: string; employee_id: string; target_date: string;
  requested_in: string | null; requested_out: string | null; reason: string | null;
  status: string; employee?: { full_name: string | null; email: string } | null;
};

// One editable clock session (admin correction).
function SessionEditRow({ session, siteNames, pings, onSave, onDelete }: {
  session: ClockSession;
  siteNames: Record<string, string>;
  pings: Ping[];
  onSave: (id: string, inIso: string | null, outIso: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const [inV, setInV] = useState(isoToLocalInput(session.clock_in_at));
  const [outV, setOutV] = useState(isoToLocalInput(session.clock_out_at));
  const inSite = session.clock_in_site_id ? siteNames[session.clock_in_site_id] : null;
  const outSite = session.clock_out_site_id ? siteNames[session.clock_out_site_id] : null;
  return (
    <div className="bg-white border border-gray-200 rounded p-2">
      <div className="flex items-end gap-2 flex-wrap">
        <label className="text-[10px] text-gray-500 flex flex-col">In
          <input type="datetime-local" value={inV} onChange={(e) => setInV(e.target.value)} className="border rounded px-1 py-0.5 text-xs" />
        </label>
        <label className="text-[10px] text-gray-500 flex flex-col">Out
          <input type="datetime-local" value={outV} onChange={(e) => setOutV(e.target.value)} className="border rounded px-1 py-0.5 text-xs" />
        </label>
        <button onClick={() => onSave(session.id, localInputToIso(inV), localInputToIso(outV))}
          className="px-2 py-1 text-xs rounded bg-brand-700 text-white hover:bg-brand-900">Save</button>
        <button onClick={() => onDelete(session.id)} className="text-xs text-red-600 hover:underline pb-1">Delete</button>
      </div>
      <div className="text-[10px] text-gray-400 mt-1">
        📍 In: {inSite || (session.clock_in_lat != null ? 'off-site' : '—')}
        {' · '}Out: {outSite || (session.clock_out_at ? (session.clock_out_lat != null ? 'off-site' : '—') : 'still in')}
      </div>
      {session.clock_in_tz && session.clock_out_tz && session.clock_in_tz !== session.clock_out_tz && (
        <div className="text-[10px] text-amber-700 mt-0.5">
          ✈ Crossed time zones — clocked in {tzAbbrev(session.clock_in_at, session.clock_in_tz)} ({session.clock_in_tz.split('/').pop()}), out {tzAbbrev(session.clock_out_at, session.clock_out_tz)} ({session.clock_out_tz.split('/').pop()}). Times shown are Mountain; the hours are the true elapsed time.
        </div>
      )}
      {pings.length > 0 && (
        <div className="text-[10px] mt-1">
          <a href={mapsPathUrl(pings)} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
            🗺️ View trail ({pings.length} point{pings.length === 1 ? '' : 's'})
          </a>
          <span className="text-gray-400">
            {' · '}{fmtClock(pings[0].recorded_at)} → {fmtClock(pings[pings.length - 1].recorded_at)}
          </span>
        </div>
      )}
    </div>
  );
}

export default function AdminHoursPage() {
  const supabase = createClient();
  const [people, setPeople] = useState<Person[]>([]);
  const [entries, setEntries] = useState<HoursEntry[]>([]);
  const [weekOptions, setWeekOptions] = useState<string[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<string>(weekKey(new Date()));
  const [loading, setLoading] = useState(true);
  // Currently-open clock sessions (employee_id → session), for the pill.
  const [openByPerson, setOpenByPerson] = useState<Record<string, ClockSession>>({});
  // Prior-day clock-ins with no clock-out in the selected week (employee_id →
  // list). These forgot-to-clock-out sessions can't be counted until an end
  // time is set, so we flag them rather than let the hours silently vanish.
  const [openInWeek, setOpenInWeek] = useState<Record<string, { date: string; in: string }[]>>({});
  // Latest breadcrumb per currently-clocked-in person (live location link).
  const [lastPing, setLastPing] = useState<Record<string, Ping>>({});
  // Breadcrumbs for the employee whose Edit panel is open, grouped by session.
  const [pingsBySession, setPingsBySession] = useState<Record<string, Ping[]>>({});
  const [clockBusy, setClockBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick so "clocked in 1h 23m" stays current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function loadOpen() {
    const { data } = await supabase
      .from('time_clock')
      .select('id, employee_id, clock_in_at, clock_out_at')
      .is('clock_out_at', null);
    const map: Record<string, ClockSession> = {};
    for (const s of (data as ClockSession[]) || []) map[s.employee_id] = s;
    setOpenByPerson(map);

    // Latest breadcrumb for each currently-clocked-in person → live map link.
    const empIds = Object.keys(map);
    if (empIds.length) {
      const { data: pings } = await supabase
        .from('time_clock_pings')
        .select('id, session_id, employee_id, lat, lng, accuracy_m, recorded_at')
        .in('employee_id', empIds)
        .order('recorded_at', { ascending: false });
      const last: Record<string, Ping> = {};
      for (const p of (pings as Ping[]) || []) if (!last[p.employee_id]) last[p.employee_id] = p;
      setLastPing(last);
    } else {
      setLastPing({});
    }
  }

  // Breadcrumbs for the employee whose Edit panel is open (this week), grouped
  // by session so each session row can show its own trail.
  async function loadEditPings(empId: string) {
    const { start, end } = weekRange(selectedWeek);
    const { data } = await supabase
      .from('time_clock_pings')
      .select('id, session_id, employee_id, lat, lng, accuracy_m, recorded_at')
      .eq('employee_id', empId)
      .gte('recorded_at', start)
      .lt('recorded_at', end)
      .order('recorded_at', { ascending: true });
    const bySession: Record<string, Ping[]> = {};
    for (const p of (data as Ping[]) || []) (bySession[p.session_id] ||= []).push(p);
    setPingsBySession(bySession);
  }

  async function clockIn(personId: string) {
    setClockBusy(personId);
    await supabase.from('time_clock').insert({ employee_id: personId });
    await loadOpen();
    await loadEntries(selectedWeek);
    setClockBusy(null);
  }
  async function clockOut(personId: string) {
    setClockBusy(personId);
    await supabase.from('time_clock')
      .update({ clock_out_at: new Date().toISOString() })
      .eq('employee_id', personId).is('clock_out_at', null);
    await loadOpen();
    await loadEntries(selectedWeek);
    setClockBusy(null);
  }

  // ── Adjustment requests ────────────────────────────────────────────────────
  const [requests, setRequests] = useState<ReqRow[]>([]);
  async function loadRequests() {
    const { data } = await supabase
      .from('time_clock_requests')
      .select('id, employee_id, target_date, requested_in, requested_out, reason, status, employee:profiles!time_clock_requests_employee_id_fkey(full_name, email)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setRequests((data as unknown as ReqRow[]) || []);
  }
  async function approveReq(r: ReqRow) {
    setClockBusy(r.id);
    // Consistent local-day window for the target date.
    const dayStart = new Date(r.target_date + 'T00:00:00');
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const { data: sess } = await supabase.from('time_clock').select('id')
      .eq('employee_id', r.employee_id)
      .gte('clock_in_at', dayStart.toISOString()).lt('clock_in_at', dayEnd.toISOString())
      .order('clock_in_at').limit(1);

    // Only apply the times the request actually specifies — never null out the
    // required clock-in (that was silently failing the whole approval).
    const patch: { clock_in_at?: string; clock_out_at?: string } = {};
    if (r.requested_in) patch.clock_in_at = r.requested_in;
    if (r.requested_out) patch.clock_out_at = r.requested_out;

    let writeErr: { message: string } | null = null;
    if (sess && sess[0]) {
      if (Object.keys(patch).length === 0) { setClockBusy(null); alert('This request has no times to apply.'); return; }
      const { error } = await supabase.from('time_clock').update(patch).eq('id', (sess[0] as { id: string }).id);
      writeErr = error;
    } else {
      if (!r.requested_in) {
        setClockBusy(null);
        alert('Can’t create a new session without a clock-in time — add the session manually, or have the employee include a clock-in.');
        return;
      }
      const { error } = await supabase.from('time_clock').insert({ employee_id: r.employee_id, clock_in_at: r.requested_in, clock_out_at: r.requested_out ?? null });
      writeErr = error;
    }
    // Only mark the request approved if the time entry actually saved.
    if (writeErr) { setClockBusy(null); alert('Could not apply the change: ' + writeErr.message); return; }

    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('time_clock_requests')
      .update({ status: 'approved', reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq('id', r.id);
    await Promise.all([loadRequests(), loadOpen(), loadEntries(selectedWeek)]);
    setClockBusy(null);
  }
  async function rejectReq(r: ReqRow) {
    const note = prompt('Reason for rejecting (optional):') || null;
    setClockBusy(r.id);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('time_clock_requests')
      .update({ status: 'rejected', admin_note: note, reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq('id', r.id);
    await loadRequests();
    setClockBusy(null);
  }

  // ── Admin session editing ──────────────────────────────────────────────────
  const [editEmp, setEditEmp] = useState<string | null>(null);
  const [editRows, setEditRows] = useState<ClockSession[]>([]);
  const [siteNames, setSiteNames] = useState<Record<string, string>>({});
  async function loadSites() {
    const { data } = await supabase.from('work_sites').select('id, name');
    const m: Record<string, string> = {};
    for (const s of (data as { id: string; name: string }[]) || []) m[s.id] = s.name;
    setSiteNames(m);
  }
  async function openEdit(empId: string) {
    if (editEmp === empId) { setEditEmp(null); return; }
    const { start, end } = weekRange(selectedWeek);
    const { data } = await supabase.from('time_clock')
      .select('id, employee_id, clock_in_at, clock_out_at, clock_in_site_id, clock_out_site_id, clock_in_lat, clock_out_lat, clock_in_tz, clock_out_tz')
      .eq('employee_id', empId).gte('clock_in_at', start).lt('clock_in_at', end).order('clock_in_at');
    setEditRows((data as ClockSession[]) || []);
    setEditEmp(empId);
    await loadEditPings(empId);
  }
  async function saveSession(id: string, inIso: string | null, outIso: string | null) {
    if (!inIso) { alert('Enter a valid clock-in time before saving.'); return; }
    if (outIso && new Date(outIso) <= new Date(inIso)) { alert('Clock-out must be after clock-in.'); return; }
    const { error } = await supabase.from('time_clock').update({ clock_in_at: inIso, clock_out_at: outIso }).eq('id', id);
    if (error) { alert('Could not save: ' + error.message); return; }
    if (editEmp) await openEditReload(editEmp);
    await Promise.all([loadOpen(), loadEntries(selectedWeek)]);
  }
  async function deleteSession(id: string) {
    if (!confirm('Delete this time entry?')) return;
    const { error } = await supabase.from('time_clock').delete().eq('id', id);
    if (error) { alert('Could not delete: ' + error.message); return; }
    if (editEmp) await openEditReload(editEmp);
    await Promise.all([loadOpen(), loadEntries(selectedWeek)]);
  }
  async function addSession(empId: string) {
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from('time_clock').insert({ employee_id: empId, clock_in_at: nowIso, clock_out_at: nowIso });
    if (error) { alert('Could not add a session: ' + error.message); return; }
    await openEditReload(empId);
    await loadEntries(selectedWeek);
  }
  async function openEditReload(empId: string) {
    const { start, end } = weekRange(selectedWeek);
    const { data } = await supabase.from('time_clock')
      .select('id, employee_id, clock_in_at, clock_out_at, clock_in_site_id, clock_out_site_id, clock_in_lat, clock_out_lat, clock_in_tz, clock_out_tz')
      .eq('employee_id', empId).gte('clock_in_at', start).lt('clock_in_at', end).order('clock_in_at');
    setEditRows((data as ClockSession[]) || []);
    await loadEditPings(empId);
  }

  async function loadPeople() {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, remote_clock')
      .in('role', ['driver', 'office', 'contractor', 'mechanic', 'labor', 'admin', 'master_admin'])
      .order('role')
      .order('full_name');
    setPeople((data as Person[]) || []);
  }

  async function toggleRemote(personId: string, remote: boolean) {
    setPeople((prev) => prev.map((p) => (p.id === personId ? { ...p, remote_clock: remote } : p)));
    await supabase.from('profiles').update({ remote_clock: remote }).eq('id', personId);
  }

  async function loadWeeks() {
    // Pull recent dates from hours AND the time clock so the dropdown shows any
    // week that has data — manual OR punched. (Without time_clock, a week where
    // people only clocked in/out — no manual hours row — was missing from the
    // selector even though the payroll data existed and loadEntries would show it.)
    const [hoursRes, clockRes] = await Promise.all([
      supabase.from('hours').select('date').order('date', { ascending: false }),
      supabase.from('time_clock').select('clock_in_at').order('clock_in_at', { ascending: false }),
    ]);
    const keys = new Set<string>();
    keys.add(weekKey(new Date()));
    (hoursRes.data || []).forEach((r: any) => {
      if (r.date) {
        const [y, m, d] = r.date.split('-').map(Number);
        keys.add(weekKey(new Date(y, m - 1, d)));
      }
    });
    (clockRes.data || []).forEach((r: any) => {
      if (r.clock_in_at) keys.add(weekKey(new Date(r.clock_in_at)));
    });
    setWeekOptions(Array.from(keys).sort().reverse());
  }

  async function loadEntries(key: string) {
    setLoading(true);
    const { start, end } = weekRange(key);

    // 1) Manual hours (drivers)
    const { data: hoursRows } = await supabase
      .from('hours')
      .select('*')
      .gte('date', start)
      .lt('date', end)
      .order('date', { ascending: true });

    // 3) Time-clock sessions for the same week (completed ones roll into hours).
    const { data: clockRows } = await supabase
      .from('time_clock')
      .select('id, employee_id, clock_in_at, clock_out_at, clock_in_tz, clock_out_tz')
      .gte('clock_in_at', start)
      .lt('clock_in_at', end);
    const clockByPersonDay = new Map<string, { hours: number; count: number; name: string; sessions: { in: string; out: string | null; inTz?: string | null; outTz?: string | null }[] }>();
    // Flag clock-ins with NO clock-out from a PRIOR day (forgot to clock out):
    // their hours can't be counted until an end time is set. A session opened
    // TODAY is left alone — the person may still be working.
    const todayStr = todayKey();
    const openFlags: Record<string, { date: string; in: string }[]> = {};
    for (const s of (clockRows as ClockSession[]) || []) {
      if (!s.clock_out_at) {
        const dstr = dayKey(s.clock_in_at);
        if (dstr < todayStr) (openFlags[s.employee_id] ||= []).push({ date: dstr, in: s.clock_in_at });
        continue; // still open — no hours until an end time is set
      }
      const inMs = new Date(s.clock_in_at).getTime();
      const outMs = new Date(s.clock_out_at).getTime();
      if (!(outMs > inMs)) continue;
      const date = dayKey(s.clock_in_at);
      const k = `${s.employee_id}__${date}`;
      const cur = clockByPersonDay.get(k) || { hours: 0, count: 0, name: '', sessions: [] };
      cur.hours += (outMs - inMs) / 3_600_000;
      cur.count += 1;
      cur.sessions.push({ in: s.clock_in_at, out: s.clock_out_at, inTz: s.clock_in_tz, outTz: s.clock_out_tz });
      clockByPersonDay.set(k, cur);
    }
    const clocked: HoursEntry[] = [];
    clockByPersonDay.forEach((v, k) => {
      const [employeeId, date] = k.split('__');
      clocked.push({
        id: `clock-${employeeId}-${date}`,
        employee_id: employeeId,
        employee_name: '',
        date,
        hours: Math.round(v.hours * 100) / 100,
        notes: null,
        is_clock: true,
        session_count: v.count,
        clock_sessions: v.sessions.sort((a, b) => a.in.localeCompare(b.in)),
      });
    });

    const all: HoursEntry[] = [
      ...((hoursRows as HoursEntry[]) || []),
      ...clocked,
    ].sort((a, b) => a.date.localeCompare(b.date));

    setEntries(all);
    setOpenInWeek(openFlags);
    setLoading(false);
  }

  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setAllowed(false); return; }
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      const ok = data?.role === 'admin' || data?.role === 'master_admin';
      setAllowed(ok);
      if (ok) { loadPeople(); loadWeeks(); loadOpen(); loadRequests(); loadSites(); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadEntries(selectedWeek);
  }, [selectedWeek]);

  const byPerson: Record<string, HoursEntry[]> = {};
  entries.forEach((e) => {
    if (!byPerson[e.employee_id]) byPerson[e.employee_id] = [];
    byPerson[e.employee_id].push(e);
  });

  function exportCSV() {
    const headers = ['Employee', 'Role', 'Date', 'Day', 'Hours', 'Source', 'Notes'];
    const rows: string[][] = [];
    people.forEach((p) => {
      const personEntries = byPerson[p.id] || [];
      personEntries.forEach((e) => {
        rows.push([
          p.full_name || p.email,
          p.role,
          e.date,
          dayLabel(e.date).split(',')[0],
          Number(e.hours).toFixed(2),
          e.is_clock ? 'time clock' : 'manual',
          e.is_clock ? `${e.session_count} session(s)` : (e.notes || ''),
        ]);
      });
      const total = personEntries.reduce((sum, e) => sum + Number(e.hours), 0);
      if (personEntries.length > 0) {
        rows.push([p.full_name || p.email, p.role, '', 'TOTAL', total.toFixed(2), '', '']);
        if (total > 40) {
          rows.push([p.full_name || p.email, p.role, '', 'Regular', '40.00', '', '']);
          rows.push([p.full_name || p.email, p.role, '', 'Overtime', (total - 40).toFixed(2), '', '']);
        }
        rows.push(['', '', '', '', '', '', '']);
      }
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${(c || '').toString().replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-week-of-${selectedWeek}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (allowed === false) {
    return (
      <div className="max-w-md">
        <p className="text-sm text-gray-600">This board is for admins. See your own time under <a href="/driver/hours" className="text-brand-700 underline">My hours</a>.</p>
      </div>
    );
  }
  if (allowed === null) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto mb-3 -mx-4 px-4">
        <div className="flex items-center gap-2 min-w-max">
          <h1 className="text-lg font-semibold whitespace-nowrap mr-2">Time clock</h1>
          <select
            value={selectedWeek}
            onChange={(e) => setSelectedWeek(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
          >
            {weekOptions.map((k) => (
              <option key={k} value={k}>
                Week of {weekLabel(k)}
              </option>
            ))}
          </select>
          <button
            onClick={exportCSV}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 whitespace-nowrap"
          >
            Export CSV
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Tap an employee&apos;s pill to clock them in; it turns into <span className="font-medium">Clock out</span> while
        they&apos;re on the clock, and the session rolls into their hours below.
      </p>
      <p className="text-[11px] text-gray-400 mb-4">
        📍 While someone is clocked in <em>and</em> has the app open, their phone reports its location. Tap{' '}
        <span className="text-brand-700">📍</span> next to a clocked-in person to see where they are now, or{' '}
        <span className="font-medium">Edit</span> a past week to view each session&apos;s trail. Location isn&apos;t
        recorded off the clock, and the trail has gaps whenever the app was closed.
      </p>

      <SelfClock />

      <WorkSitesManager />

      {requests.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          <h2 className="font-semibold text-amber-900 text-sm mb-2">Adjustment requests ({requests.length})</h2>
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="bg-white border border-amber-200 rounded-md p-2.5 flex items-start justify-between gap-2 flex-wrap">
                <div className="text-xs min-w-0">
                  <div className="font-medium">{r.employee?.full_name || r.employee?.email || 'Employee'}</div>
                  <div className="text-gray-600">{dayLabel(r.target_date)} · {fmtClock(r.requested_in)} – {fmtClock(r.requested_out)}</div>
                  {r.reason && <div className="text-gray-500">{r.reason}</div>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => approveReq(r)} disabled={clockBusy === r.id}
                    className="px-3 py-1 text-xs rounded-md bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">Approve</button>
                  <button onClick={() => rejectReq(r)} disabled={clockBusy === r.id}
                    className="px-3 py-1 text-xs rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : people.length === 0 ? (
        <p className="text-xs text-gray-500 text-center py-12">No drivers or salesmen on file.</p>
      ) : (
        <div className="space-y-4">
          {people.map((p) => {
            const personEntries = byPerson[p.id] || [];
            const total = personEntries.reduce((sum, e) => sum + Number(e.hours), 0);
            const regular = Math.min(total, 40);
            const overtime = Math.max(total - 40, 0);
            const hasOT = overtime > 0;
            const displayName = p.full_name || p.email;
            const roleLabel = p.role === 'master_admin' ? 'Master admin' : p.role.charAt(0).toUpperCase() + p.role.slice(1);
            const open = openByPerson[p.id];

            return (
              <div key={p.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-3 py-2 border-b border-gray-200 flex justify-between items-center flex-wrap gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm">{displayName}</span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-500">{roleLabel}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {personEntries.length === 0 ? (
                      <span className="text-xs text-gray-400">
                        No hours logged
                      </span>
                    ) : (
                      <div className="text-xs flex gap-2 items-baseline">
                        <span className="font-medium">{total.toFixed(2)} hrs</span>
                        {hasOT && (
                          <span className="text-gray-500">
                            ({regular.toFixed(2)} reg + <span className="text-red-600 font-medium">{overtime.toFixed(2)} OT</span>)
                          </span>
                        )}
                      </div>
                    )}
                    {(openInWeek[p.id]?.length ?? 0) > 0 && (
                      <button
                        onClick={() => openEdit(p.id)}
                        title="Clocked in but never clocked out — these hours aren't counted until you set an end time. Tap to fix."
                        className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-300 rounded-full px-2.5 py-1 whitespace-nowrap hover:bg-red-100"
                      >
                        ⚠ {openInWeek[p.id].length} not clocked out
                      </button>
                    )}
                    {open ? (
                      <button
                        onClick={() => clockOut(p.id)}
                        disabled={clockBusy === p.id}
                        className="px-3 py-1 text-xs rounded-full bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        ● Clock out{elapsed(open.clock_in_at, now) ? ` · ${elapsed(open.clock_in_at, now)}` : ''}
                      </button>
                    ) : (
                      <button
                        onClick={() => clockIn(p.id)}
                        disabled={clockBusy === p.id}
                        className="px-3 py-1 text-xs rounded-full bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        {clockBusy === p.id ? '…' : 'Clock in'}
                      </button>
                    )}
                    {open && lastPing[p.id] && (
                      <a
                        href={mapsPointUrl(lastPing[p.id].lat, lastPing[p.id].lng)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Last seen ${elapsed(lastPing[p.id].recorded_at, now) || 'just now'} ago`}
                        className="text-[11px] text-brand-700 hover:underline whitespace-nowrap"
                      >
                        📍 {elapsed(lastPing[p.id].recorded_at, now) || 'now'}
                      </a>
                    )}
                    <button onClick={() => openEdit(p.id)} className="text-xs text-brand-700 hover:underline whitespace-nowrap">
                      {editEmp === p.id ? 'Done' : 'Edit'}
                    </button>
                    <label className="text-[10px] text-gray-500 flex items-center gap-1 whitespace-nowrap" title="Skip the geofence — for out-of-state / field drivers">
                      <input type="checkbox" checked={!!p.remote_clock} onChange={(e) => toggleRemote(p.id, e.target.checked)} />
                      remote
                    </label>
                  </div>
                </div>
                {personEntries.length > 0 && (
                  <table className="w-full text-xs">
                    <tbody>
                      {personEntries.map((e) => (
                        <tr key={e.id} className="border-b border-gray-100 last:border-b-0">
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap w-24 align-top">
                            {dayLabel(e.date)}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium tabular-nums">{Number(e.hours).toFixed(2)} hrs</div>
                            {e.is_clock && e.clock_sessions && e.clock_sessions.length > 0 && (
                              <div className="mt-0.5 space-y-0.5">
                                {e.clock_sessions.map((s, i) => {
                                  const crossed = !!(s.inTz && s.outTz && s.inTz !== s.outTz);
                                  return (
                                    <div key={i} className="text-[10px] text-gray-400 whitespace-nowrap">
                                      {fmtClock(s.in)}{crossed ? ` ${tzAbbrev(s.in, s.inTz ?? null)}` : ''} – {fmtClock(s.out)}{crossed ? ` ${tzAbbrev(s.out, s.outTz ?? null)}` : ''}
                                      {crossed && <span className="ml-1 text-amber-600 font-medium">✈ crossed zones</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-600 break-words">
                            {e.is_clock ? (
                              <span className="text-gray-500">
                                <span className="text-[10px] uppercase tracking-wide bg-green-50 text-green-800 px-1.5 py-0.5 rounded">clock</span>{' '}
                                {e.session_count} session{e.session_count === 1 ? '' : 's'}
                                {e.clock_sessions && e.clock_sessions.length > 0 && (
                                  <span className="block text-[10px] text-gray-400 mt-0.5">
                                    {e.clock_sessions.map((s) => `${fmtClock(s.in)} – ${fmtClock(s.out)}`).join(', ')}
                                  </span>
                                )}
                              </span>
                            ) : (
                              e.notes || <span className="text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {editEmp === p.id && (
                  <div className="px-3 py-3 border-t border-gray-200 bg-gray-50 space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Edit clock sessions (this week)</div>
                    {editRows.length === 0 && <p className="text-xs text-gray-400">No clock sessions this week. Add one below.</p>}
                    {editRows.map((s) => (
                      <SessionEditRow key={s.id} session={s} siteNames={siteNames} pings={pingsBySession[s.id] || []} onSave={saveSession} onDelete={deleteSession} />
                    ))}
                    <button onClick={() => addSession(p.id)} className="text-xs text-brand-700 hover:underline font-medium">+ Add session</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
