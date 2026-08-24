// POST /api/work-orders/[id]/invoice — invoice an approved ticket in
// QuickBooks. Office/admin only.
//
// Approval normally invoices the ticket in one step; this is the retry when
// QuickBooks was down, unlinked, or missing its item at that moment.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { invoiceWorkOrder } from '@/lib/work-orders';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !['office', 'admin', 'master_admin'].includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'office only' }, { status: 403 });
  }

  const db = createAdminClient();
  const { data: wo } = await db
    .from('work_orders')
    .select('id, status')
    .eq('id', params.id)
    .maybeSingle();
  if (!wo) return NextResponse.json({ ok: false, error: 'work order not found' }, { status: 404 });
  if (!['office_approved', 'funds_approved'].includes((wo as { status: string }).status)) {
    return NextResponse.json({ ok: false, error: 'approve the ticket before invoicing it' }, { status: 400 });
  }

  const result = await invoiceWorkOrder(db, params.id);
  return NextResponse.json(result.body, { status: result.status });
}
