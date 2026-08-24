'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Lets an employee request a time-clock correction (e.g. forgot to clock in or
// out). Creates a pending request; an admin approves it on the Time clock board,
// which edits/creates the session. Shows the employee their recent requests.

type Req = {
  id: string;
  target_date: string;
  requested_in: string | null;
  requested_out: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  admin_note: string | null;
};

function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
}
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
// Combine a YYYY-MM-DD date + HH:MM (local) into an ISO timestamp, or null.
function toISO(date: string, time: string): string | null {
  if (!time) return null;
  // Build from numeric parts (local time) — Safari/iOS returns Invalid Date for
  // `new Date("2026-08-05T12:37")`, which would silently drop the requested time.
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date || '').trim());
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((time || '').trim());
  if (dm && tm) {
    const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] || '0'));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(`${date}T${time}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export default function TimeAdjustmentRequest() {
  const supabase = createClient();
  const [meId, setMeId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reqs, setReqs] = useState<Req[]>([]);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setMeId(user.id);
    const { data } = await supabase
      .from('time_clock_requests')
      .select('id, target_date, requested_in, requested_out, reason, status, admin_note')
      .eq('employee_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    setReqs((data as Req[]) || []);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  async function submit() {
    setErr('');
    if (!meId) return;
    const rin = toISO(date, inTime);
    const rout = toISO(date, outTime);
    if (!rin && !rout) { setErr('Enter a clock-in and/or clock-out time.'); return; }
    if (rin && rout && new Date(rout) <= new Date(rin)) { setErr('Clock-out must be after clock-in.'); return; }
    setBusy(true);
    const { error } = await supabase.from('time_clock_requests').insert({
      employee_id: meId,
      target_date: date,
      requested_in: rin,
      requested_out: rout,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setInTime(''); setOutTime(''); setReason(''); setOpen(false);
    load();
  }

  const statusChip = (s: Req['status']) => {
    const cls = s === 'approved' ? 'bg-green-100 text-green-800'
      : s === 'rejected' ? 'bg-red-100 text-red-700'
      : 'bg-amber-100 text-amber-800';
    return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cls}`}>{s}</span>;
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-sm">Forgot to clock in or out?</h2>
          <p className="text-xs text-gray-500">Request a correction — an admin approves it.</p>
        </div>
        <button onClick={() => setOpen((v) => !v)}
          className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white hover:bg-brand-900 font-medium whitespace-nowrap">
          {open ? 'Close' : 'Request adjustment'}
        </button>
      </div>

      {open && (
        <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <label className="text-xs text-gray-600 flex flex-col">Date
              <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)}
                className="mt-0.5 border rounded px-2 py-1 text-sm" />
            </label>
            <label className="text-xs text-gray-600 flex flex-col">Clock in
              <input type="time" value={inTime} onChange={(e) => setInTime(e.target.value)}
                className="mt-0.5 border rounded px-2 py-1 text-sm" />
            </label>
            <label className="text-xs text-gray-600 flex flex-col">Clock out
              <input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)}
                className="mt-0.5 border rounded px-2 py-1 text-sm" />
            </label>
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (e.g. forgot to clock out)"
            className="w-full border rounded px-2 py-1.5 text-sm" />
          {err && <p className="text-xs text-red-600">{err}</p>}
          <button onClick={submit} disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 font-medium">
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
      )}

      {reqs.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-2 space-y-1">
          {reqs.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0">
                <span className="font-medium">{fmtDate(r.target_date)}</span>
                <span className="text-gray-500"> · {fmtTime(r.requested_in)} – {fmtTime(r.requested_out)}</span>
                {r.reason && <span className="text-gray-400"> · {r.reason}</span>}
                {r.status === 'rejected' && r.admin_note && <span className="text-red-600"> · {r.admin_note}</span>}
              </span>
              {statusChip(r.status)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
