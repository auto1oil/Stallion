// POST /api/admin/relink-qb-customer — admin-only. Point a business at a live
// QuickBooks customer id (fixes an order that can't invoice because the linked QB
// customer was merged/deleted, or was never linked to the right record).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const businessId = String(body.business_id || '');
  const qbCustomerId = String(body.qb_customer_id || '');
  const qbCustomerName = body.qb_customer_name ? String(body.qb_customer_name) : null;
  if (!businessId || !qbCustomerId) {
    return NextResponse.json({ ok: false, error: 'business_id and qb_customer_id required' }, { status: 400 });
  }

  const db = createAdminClient();
  const { error } = await db
    .from('businesses')
    .update({ qb_customer_id: qbCustomerId })
    .eq('id', businessId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Keep the per-profile mapping in step so other flows resolve the same record.
  // Best-effort: the business link above is what invoicing uses.
  try {
    const { data: profs } = await db.from('profiles').select('id').eq('business_id', businessId);
    for (const p of (profs as { id: string }[] | null) || []) {
      await db.from('customer_qb_mapping').upsert(
        { profile_id: p.id, qb_customer_id: qbCustomerId, qb_customer_name: qbCustomerName, updated_at: new Date().toISOString() },
        { onConflict: 'profile_id' },
      );
    }
  } catch { /* mapping is a convenience cache; ignore */ }

  return NextResponse.json({ ok: true });
}
