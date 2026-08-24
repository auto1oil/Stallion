// POST /api/admin/confirm-customer-email  — body { customer_id }
//
// Admin only. Marks a customer's auth email as confirmed (server-side, via the
// service-role admin API) so they can sign in. Used when the Supabase
// confirmation email never reached them. Idempotent.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    let body: { customer_id?: string };
    try { body = (await req.json()) as { customer_id?: string }; } catch { body = {}; }
    if (!body.customer_id) return NextResponse.json({ ok: false, error: 'customer_id required' }, { status: 400 });

    const db = createAdminClient();
    const { error } = await db.auth.admin.updateUserById(body.customer_id, { email_confirm: true });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
