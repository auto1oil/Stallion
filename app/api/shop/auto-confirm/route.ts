// POST /api/shop/auto-confirm  — body { user_id }
//
// Called right after a customer signs up. Marks their email confirmed via the
// service-role admin API so they can sign in immediately — Supabase's built-in
// confirmation email is unreliable, and customers are gated by admin business-
// link approval anyway. Restricted to customer-role accounts so it can't be
// used to confirm staff logins.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    let body: { user_id?: string };
    try { body = (await req.json()) as { user_id?: string }; } catch { body = {}; }
    if (!body.user_id) return NextResponse.json({ ok: false, error: 'user_id required' }, { status: 400 });

    const db = createAdminClient();
    const { data: profile } = await db.from('profiles').select('role').eq('id', body.user_id).maybeSingle();
    if (!profile || profile.role !== 'customer') {
      // Don't confirm staff/unknown accounts here.
      return NextResponse.json({ ok: false, error: 'not a customer account' }, { status: 403 });
    }

    const { error } = await db.auth.admin.updateUserById(body.user_id, { email_confirm: true });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
