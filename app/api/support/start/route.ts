// POST /api/support/start — anonymous visitor opens a support chat.
// Body: { name, phone?, email? }  → { ok, session_id, guest_token }
// Honors the admin require-phone/require-email toggles AND the chat schedule.
// Uses the service-role key (no anonymous RLS); the returned guest_token scopes
// the visitor.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { randomUUID } from 'crypto';
import { SUPPORT_HOURS_KEYS, parseSupportHours, isWithinSupportHours } from '@/lib/support-hours';

export const runtime = 'nodejs';

const ALL_KEYS = ['support_require_phone', 'support_require_email', ...SUPPORT_HOURS_KEYS];

async function loadCfg(admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin.from('app_settings').select('key, value').in('key', ALL_KEYS);
  return Object.fromEntries(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
}

export async function POST(req: Request) {
  let body: { name?: string; phone?: string; email?: string };
  try { body = await req.json(); } catch { body = {}; }

  const admin = createAdminClient();
  const cfg = await loadCfg(admin);

  // Closed per schedule? Block new chats.
  const hours = parseSupportHours(cfg);
  if (!isWithinSupportHours(hours)) {
    return NextResponse.json({ ok: false, closed: true, error: hours.offlineMsg }, { status: 403 });
  }

  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim();
  const email = (body.email || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'Please enter your name.' }, { status: 400 });
  if (cfg.support_require_phone === 'true' && !phone) return NextResponse.json({ ok: false, error: 'Please enter your phone number.' }, { status: 400 });
  if (cfg.support_require_email === 'true' && !email) return NextResponse.json({ ok: false, error: 'Please enter your email.' }, { status: 400 });

  const guest_token = randomUUID();
  const { data, error } = await admin
    .from('support_sessions')
    .insert({ guest_token, guest_name: name, guest_phone: phone || null, guest_email: email || null })
    .select('id')
    .single();
  if (error || !data) return NextResponse.json({ ok: false, error: error?.message || 'Could not start chat.' }, { status: 500 });

  return NextResponse.json({ ok: true, session_id: data.id, guest_token });
}

// GET /api/support/start → form config + whether the chat is currently open.
export async function GET() {
  const admin = createAdminClient();
  const cfg = await loadCfg(admin);
  const hours = parseSupportHours(cfg);
  return NextResponse.json({
    ok: true,
    require_phone: cfg.support_require_phone === 'true',
    require_email: cfg.support_require_email === 'true',
    open: isWithinSupportHours(hours),
    offline_message: hours.offlineMsg,
  });
}
