// Support-chat schedule. Stored in app_settings as:
//   support_hours_enabled : 'true' | 'false'   (false = always open)
//   support_hours_days    : CSV of open weekday numbers, 0=Sun..6=Sat e.g. '1,2,3,4,5'
//   support_hours_start   : 'HH:MM' (24h, local to support_hours_tz)
//   support_hours_end     : 'HH:MM'
//   support_hours_tz      : IANA tz, e.g. 'America/Denver'
//   support_offline_msg   : message shown when closed

export type SupportHours = {
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
  tz: string;
  offlineMsg: string;
};

export const SUPPORT_HOURS_KEYS = [
  'support_hours_enabled', 'support_hours_days', 'support_hours_start',
  'support_hours_end', 'support_hours_tz', 'support_offline_msg',
];

export function parseSupportHours(cfg: Record<string, string>): SupportHours {
  return {
    enabled: cfg.support_hours_enabled === 'true',
    days: (cfg.support_hours_days ?? '0,1,2,3,4,5,6').split(',').map((d) => parseInt(d, 10)).filter((n) => !Number.isNaN(n)),
    start: cfg.support_hours_start || '08:00',
    end: cfg.support_hours_end || '17:00',
    tz: cfg.support_hours_tz || 'America/Denver',
    offlineMsg: cfg.support_offline_msg || "We're offline right now. Leave a message and we'll get back to you.",
  };
}

// Is the chat currently open per the schedule? Always true when not enabled.
export function isWithinSupportHours(h: SupportHours, now = new Date()): boolean {
  if (!h.enabled) return true;
  try {
    // Current weekday + HH:MM in the configured timezone.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: h.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const wkMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const wk = wkMap[parts.find((p) => p.type === 'weekday')?.value ?? ''];
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    if (wk === undefined || !h.days.includes(wk)) return false;
    const cur = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    const [sH, sM] = h.start.split(':').map((x) => parseInt(x, 10));
    const [eH, eM] = h.end.split(':').map((x) => parseInt(x, 10));
    const startMin = sH * 60 + (sM || 0);
    const endMin = eH * 60 + (eM || 0);
    return cur >= startMin && cur < endMin;
  } catch {
    return true; // any parsing failure → don't block chat
  }
}
