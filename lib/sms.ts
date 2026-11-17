// ============================================================================
// Text messages — Twilio, best-effort, never in the way.
// ============================================================================
// When loads go out, the hauler's people get a text on top of the in-app
// notification and the push. The Twilio credentials live in app_settings
// (master-admin only, like the other keys); no credentials saved simply
// means no texts, and a failed text never fails a dispatch.

import type { SupabaseClient } from '@supabase/supabase-js';

// Where links in texts point. Each cloned app sets its own in Vercel env.
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://stallion-jade.vercel.app')
  .replace(/\/$/, '');

type SmsConfig = { sid: string; token: string; from: string };

export async function getSmsConfig(db: SupabaseClient): Promise<SmsConfig | null> {
  const { data } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', ['twilio_account_sid', 'twilio_auth_token', 'twilio_from_number']);
  const m = new Map(((data as { key: string; value: string | null }[]) || [])
    .map((r) => [r.key, (r.value || '').trim()]));
  const sid = m.get('twilio_account_sid') || '';
  const token = m.get('twilio_auth_token') || '';
  const from = m.get('twilio_from_number') || '';
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

// US numbers, typed however people type them, to E.164. Anything that isn't
// ten digits (or eleven starting with 1) is skipped rather than guessed at.
export function normalizeUsPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+') && digits.length > 10) return `+${digits}`;
  return null;
}

// Fire one text per number. Best-effort by design: bad numbers are skipped,
// Twilio errors are swallowed — the load is already placed either way.
export async function sendSms(db: SupabaseClient, phones: (string | null | undefined)[], body: string): Promise<void> {
  try {
    const config = await getSmsConfig(db);
    if (!config) return;
    const targets = Array.from(new Set(
      phones.map(normalizeUsPhone).filter((p): p is string => !!p),
    ));
    if (targets.length === 0) return;

    const auth = Buffer.from(`${config.sid}:${config.token}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`;
    await Promise.all(targets.map(async (to) => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: config.from, Body: body }).toString(),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        /* one number failing must not stop the rest */
      }
    }));
  } catch {
    /* texting is a layer on top — never the reason a dispatch fails */
  }
}
