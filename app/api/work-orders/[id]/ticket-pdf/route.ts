// POST /api/work-orders/[id]/ticket-pdf — build the printable haul-ticket
// PDF fresh from the row and hand back a short-lived link.
//
// This is what the share button uses: once the foreman has signed, the
// driver texts / emails / AirDrops the ticket straight from the phone. The
// PDF is regenerated on every call so it always shows the ticket as it
// stands, signatures and all.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { ensureTicketPdf } from '@/lib/ticket-pdf';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  // Whoever can read the ticket can share it — RLS answers that.
  const { data: visible } = await supabase
    .from('work_orders')
    .select('id, ticket_number, job_number, job_date')
    .eq('id', params.id)
    .maybeSingle();
  if (!visible) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const db = createAdminClient();
  const made = await ensureTicketPdf(db, params.id);
  if (!made) {
    return NextResponse.json({ ok: false, error: 'could not build the ticket PDF — try again' }, { status: 500 });
  }
  const { data: signed } = await db.storage
    .from('work-tickets').createSignedUrl(made.path, 600);
  if (!signed?.signedUrl) {
    return NextResponse.json({ ok: false, error: 'could not link the PDF — try again' }, { status: 500 });
  }

  const row = visible as { ticket_number: string | null; job_number: string | null; job_date: string | null };
  const name = ['haul-ticket', row.ticket_number || row.job_number, row.job_date]
    .filter(Boolean).join('-').replace(/[^\w.-]+/g, '_');
  return NextResponse.json({ ok: true, url: signed.signedUrl, filename: `${name}.pdf` });
}
