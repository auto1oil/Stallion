// POST /api/work-orders/[id]/factor — resend an approved factor-pay ticket to
// the factoring app. Office/admin only.
//
// Approval normally does this in one step; this is the retry for when the
// factoring app was down, unreachable, or not yet connected at that moment.
// The same idempotency rule applies: a ticket that already went through is
// reported as sent, not sent twice.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { sendTicketToFactoring } from '@/lib/factoring';

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
    .select('id, payment_method, office_approved_at, factor_sent_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!wo) return NextResponse.json({ ok: false, error: 'work order not found' }, { status: 404 });

  const row = wo as { payment_method: string | null; office_approved_at: string | null; factor_sent_at: string | null };
  if (row.payment_method !== 'factor') {
    return NextResponse.json({ ok: false, error: 'this ticket is standard pay, not factored' }, { status: 400 });
  }
  // "Approved and ready to fund" has to be true before it's said to anyone.
  if (!row.office_approved_at) {
    return NextResponse.json({ ok: false, error: 'approve the ticket before sending it to factoring' }, { status: 400 });
  }

  const result = await sendTicketToFactoring(db, params.id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error || 'factoring hand-off failed' }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    already_sent: !!row.factor_sent_at,
  });
}
