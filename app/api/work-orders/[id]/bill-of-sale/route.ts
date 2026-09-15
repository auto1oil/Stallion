// POST /api/work-orders/[id]/bill-of-sale — get (or refresh) the factoring
// app's bill of sale for a factor-pay ticket.
//
// The factoring app renders the document and the hauler signs it there; this
// route exists because the API key lives server-side, never in the browser.
// Idempotent: the same ticket always gets the same URL back, along with the
// current acceptance state, so the form can re-call it to poll for the
// signature.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requestBillOfSale } from '@/lib/factoring';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles').select('role, hauler_id').eq('id', user.id).single();

  const db = createAdminClient();
  const { data: wo } = await db
    .from('work_orders')
    .select('id, hauler_id, submitted_by, assigned_to')
    .eq('id', params.id)
    .maybeSingle();
  if (!wo) return NextResponse.json({ ok: false, error: 'work order not found' }, { status: 404 });

  // The hauler's own people (it's their document to sign) and the office.
  const row = wo as { hauler_id: string | null; submitted_by: string | null; assigned_to: string | null };
  const isStaff = ['office', 'admin', 'master_admin'].includes(actor?.role || '');
  const isTheirs = !!actor?.hauler_id && actor.hauler_id === row.hauler_id;
  if (!isStaff && !isTheirs) {
    return NextResponse.json({ ok: false, error: 'not your ticket' }, { status: 403 });
  }

  const result = await requestBillOfSale(db, params.id);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error || 'could not get the bill of sale', unreachable: !!result.unreachable },
      { status: result.unreachable ? 502 : 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    url: result.url,
    accepted: result.accepted,
    accepted_by: result.accepted_by,
    accepted_at: result.accepted_at,
  });
}
