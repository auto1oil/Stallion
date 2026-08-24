// GET /api/shop/invoice-pdf?orderId=… — customer-facing.
//
// Streams the QuickBooks invoice PDF for ONE of the signed-in customer's own
// orders. Ownership is enforced by reading the order with the customer's own
// session (RLS only returns their orders); the QuickBooks lookup + PDF fetch
// then run server-side.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { qbFetch, fetchInvoicePdf } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type QBInvoice = { Id: string; DocNumber?: string };

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get('orderId');
  if (!orderId) return NextResponse.json({ ok: false, error: 'orderId required' }, { status: 400 });

  // RLS: only returns a row for an order this customer is allowed to see.
  const { data: order } = await supabase
    .from('customer_orders').select('id, invoice_number').eq('id', orderId).maybeSingle();
  if (!order) return NextResponse.json({ ok: false, error: 'order not found' }, { status: 404 });
  const num = ((order as { invoice_number: string | null }).invoice_number || '').trim();
  if (!num) return NextResponse.json({ ok: false, error: 'This order has no invoice yet.' }, { status: 404 });

  try {
    const escaped = num.replace(/'/g, "''");
    const res = await qbFetch<{ QueryResponse: { Invoice?: QBInvoice[] } }>(
      `/query?query=${encodeURIComponent(`select Id, DocNumber from Invoice where DocNumber = '${escaped}'`)}`,
    );
    const inv = res.QueryResponse.Invoice?.[0];
    if (!inv) return NextResponse.json({ ok: false, error: 'Invoice not found in QuickBooks.' }, { status: 404 });

    const pdf = await fetchInvoicePdf(inv.Id);
    const safeDoc = num.replace(/[^a-zA-Z0-9_-]/g, '');
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${safeDoc}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 502 });
  }
}
