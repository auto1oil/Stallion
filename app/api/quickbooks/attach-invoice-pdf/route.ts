// POST /api/quickbooks/attach-invoice-pdf — admin-only. For a dispatched order
// that has an invoice number but no attached PDF, look up the invoice in
// QuickBooks by its number, download the PDF, store it, and link it on the order.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { qbFetch, fetchInvoicePdf } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type QBInvoice = { Id: string; DocNumber?: string };

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const orderId = String(body.order_id || '');
  if (!orderId) return NextResponse.json({ ok: false, error: 'order_id required' }, { status: 400 });

  const db = createAdminClient();
  const { data: order } = await db.from('orders').select('id, invoice_number, invoice_pdf_path').eq('id', orderId).single();
  if (!order) return NextResponse.json({ ok: false, error: 'order not found' }, { status: 404 });
  const num = (order.invoice_number || '').trim();
  if (!num) return NextResponse.json({ ok: false, error: 'This order has no invoice number to look up.' }, { status: 400 });

  try {
    const escaped = num.replace(/'/g, "''");
    const res = await qbFetch<{ QueryResponse: { Invoice?: QBInvoice[] } }>(
      `/query?query=${encodeURIComponent(`select * from Invoice where DocNumber = '${escaped}'`)}`,
    );
    const inv = res.QueryResponse.Invoice?.[0];
    if (!inv) return NextResponse.json({ ok: false, error: `No QuickBooks invoice found with number ${num}.` }, { status: 404 });

    const pdfBytes = await fetchInvoicePdf(inv.Id);
    const path = `${orderId}/qb-invoice-${num}.pdf`;
    const { error: upErr } = await db.storage.from('invoices').upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return NextResponse.json({ ok: false, error: `Could not store the PDF: ${upErr.message}` }, { status: 500 });

    const { error: updErr } = await db.from('orders').update({ invoice_pdf_path: path }).eq('id', orderId);
    if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks fetch failed' }, { status: 502 });
  }
}
