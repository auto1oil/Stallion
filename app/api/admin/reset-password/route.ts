// POST /api/admin/reset-password — body { user_id }
//
// Admin/master only. Sets a NEW temporary password for any user (staff or
// customer) via the service-role admin API, confirms their email so they can
// sign in, and flags must_change_password so they're forced to pick a new one
// on next sign-in. Returns the temp password to hand to the user — we don't
// rely on email here (the whole reason this button exists is mail not landing).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

function tempPassword(): string {
  // Readable temp password, e.g. "Auto1-7gk2qd".
  return `Auto1-${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    let body: { user_id?: string };
    try { body = (await req.json()) as { user_id?: string }; } catch { body = {}; }
    if (!body.user_id) return NextResponse.json({ ok: false, error: 'user_id required' }, { status: 400 });

    const db = createAdminClient();
    const password = tempPassword();
    const { error } = await db.auth.admin.updateUserById(body.user_id, {
      password,
      email_confirm: true,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // Force them to choose a new password on next sign-in (best-effort — a
    // missing column shouldn't fail the reset).
    await db.from('profiles').update({ must_change_password: true }).eq('id', body.user_id);

    return NextResponse.json({ ok: true, password });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
