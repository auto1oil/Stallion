// POST /api/auth/login-event — record a successful sign-in.
//
// Called by the login page the moment signInWithPassword succeeds. Identity
// comes from the session, never the request body; the address and device
// come from the request itself. Writes with the service role — the table has
// no insert policy for browsers, so a trail can't be forged or scrubbed from
// one.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  // First hop of x-forwarded-for is the client on Vercel.
  const fwd = req.headers.get('x-forwarded-for') || '';
  const ip = (fwd.split(',')[0] || req.headers.get('x-real-ip') || '').trim() || null;
  const ua = (req.headers.get('user-agent') || '').slice(0, 300) || null;

  try {
    await createAdminClient().from('login_events').insert({
      user_id: user.id,
      email: user.email ?? null,
      ip,
      user_agent: ua,
    });
  } catch { /* the sign-in itself must never fail over its own logbook */ }

  return NextResponse.json({ ok: true });
}
