// The time clock runs on ONE fixed timezone — Mountain (America/Denver) —
// regardless of where the employee or the viewer physically is. Durations are
// already correct (clock_in_at/clock_out_at are absolute UTC instants); this
// module keeps the *displayed* times and the *day* a shift belongs to
// consistent, so an employee crossing a timezone line (or an admin on a device
// in another zone) never sees a phantom missing/extra hour.

export const TIME_ZONE = 'America/Denver';

// Absolute instant → "5:03 PM" in Mountain time.
export function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
}

// Absolute instant → "YYYY-MM-DD" of the Mountain-time day it falls on
// (used to bucket a shift onto the right calendar day / work week).
export function dayKey(iso: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// Today's Mountain-time day key.
export function todayKey(): string {
  return dayKey(new Date().toISOString());
}

// "YYYY-MM-DD" → "Tue 8/18" for display.
export function fmtDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
}

// Offset of Mountain time from UTC, in minutes, at a given instant (DST-aware).
function offsetMinutes(date: Date): number {
  const local = new Date(date.toLocaleString('en-US', { timeZone: TIME_ZONE }));
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (local.getTime() - utc.getTime()) / 60000;
}

// Absolute instant → "YYYY-MM-DDTHH:mm" of the Mountain wall-clock time, for a
// <input type="datetime-local">. So an admin editing a session always edits it
// in Mountain time, no matter their own device timezone.
export function isoToMountainInput(iso: string | null): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '';
  let hour = g('hour');
  if (hour === '24') hour = '00'; // some engines emit 24 for midnight
  return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}`;
}

// Short zone label ("CDT", "MDT") for the timezone a punch was made in, at that
// instant. Empty when unknown. Used to flag cross-zone shifts on the board.
export function tzAbbrev(iso: string | null, tz: string | null): string {
  if (!iso || !tz) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(iso));
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

// "YYYY-MM-DDTHH:mm" Mountain wall-clock time → absolute ISO instant.
export function mountainInputToIso(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec((v || '').trim());
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = offsetMinutes(new Date(asUTC));
  const inst = asUTC - off * 60000;
  return Number.isNaN(inst) ? null : new Date(inst).toISOString();
}
