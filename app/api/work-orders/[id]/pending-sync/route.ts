// POST /api/work-orders/[id]/pending-sync — refresh the ticket's pending deal
// at the funding app with the latest numbers.
//
// The load lines write their stamps straight to the database from the field,
// so the server never sees those changes pass through a route — this is the
// nudge the stamping UI fires afterwards. The sender itself decides whether
// anything actually goes out (hauler ticket, link active, still pending), so
// for everyone else this is a cheap no-op.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { sendPendingTicket } from '@/lib/factoring';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  // Visible-through-RLS is the whole auth story: if they can read the ticket,
  // they can nudge its feed. The nudge writes nothing to the ticket itself.
  const { data: visible } = await supabase
    .from('work_orders').select('id, hauler_id').eq('id', params.id).maybeSingle();
  if (!visible) return NextResponse.json({ ok: false }, { status: 404 });
  if (!(visible as { hauler_id: string | null }).hauler_id) {
    return NextResponse.json({ ok: true, sent: false });
  }

  const result = await sendPendingTicket(createAdminClient(), params.id);
  return NextResponse.json({ ok: true, sent: result.ok });
}
