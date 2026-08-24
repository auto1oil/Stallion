// POST /api/admin/delete-customer  — body { id }
//
// Master-admin only. Deletes a customer's dependent rows and profile using
// the admin's own session (governed by the master-admin delete policies in
// supabase-setup.sql section 22) — no service-role key required. If the
// service-role key happens to be set, we also remove their auth login.

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
    const isMaster = me?.role === 'master_admin';
    const isAdmin = me?.role === 'admin' || isMaster;
    if (!isAdmin) {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    let body: { id?: string };
    try { body = (await req.json()) as { id?: string }; } catch { body = {}; }
    if (!body.id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

    const { data: target, error: tErr } = await supabase
      .from('profiles')
      .select('id, role, email')
      .eq('id', body.id)
      .maybeSingle();
    if (tErr) return NextResponse.json({ ok: false, error: `Lookup failed: ${tErr.message}` }, { status: 500 });
    if (!target) return NextResponse.json({ ok: false, error: `No profile found for id ${body.id}` }, { status: 404 });
    if (target.role !== 'customer') {
      return NextResponse.json({ ok: false, error: 'only customer accounts can be deleted here' }, { status: 400 });
    }
    // A QuickBooks-imported placeholder (synthetic qb-…@auto1oil.local login,
    // never a real sign-in) can be removed by any admin — these are the
    // duplicate cards left behind after a merge. Deleting a real customer
    // (with a genuine login) stays master-admin-only.
    const isPlaceholder = (target.email || '').endsWith('@auto1oil.local');
    if (!isPlaceholder && !isMaster) {
      return NextResponse.json({ ok: false, error: 'Only a master admin can delete a real customer account. (This one has a real login.)' }, { status: 403 });
    }

    // Clear dependent rows, then the profile — all through the admin's session
    // (the section-22 delete policies permit master admins to do this).
    await supabase.from('business_link_requests').delete().eq('profile_id', body.id);
    await supabase.from('customer_qb_mapping').delete().eq('profile_id', body.id);
    await supabase.from('customer_documents').delete().eq('customer_id', body.id);
    await supabase.from('notifications').delete().eq('recipient_id', body.id);

    const { data: ords } = await supabase.from('customer_orders').select('id').eq('customer_id', body.id);
    const orderIds = (ords || []).map((o) => o.id);
    if (orderIds.length > 0) {
      await supabase.from('customer_order_items').delete().in('customer_order_id', orderIds);
      await supabase.from('customer_orders').delete().eq('customer_id', body.id);
    }

    const { error: pErr } = await supabase.from('profiles').delete().eq('id', body.id);
    if (pErr) return NextResponse.json({ ok: false, error: `Profile delete failed: ${pErr.message}` }, { status: 500 });

    // Best-effort: also remove their auth login (needs the service-role key).
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try { await createAdminClient().auth.admin.deleteUser(body.id); } catch { /* ignore */ }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
