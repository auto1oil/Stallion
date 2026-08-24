// GET /api/quickbooks/invoice-pdf?id=…&doc=… — admin-only.
//
// Streams a single invoice's rendered PDF from QuickBooks. Opens inline in the
// browser (which lets the admin view it or save it to disk). QuickBooks keeps
// invoices indefinitely, so any past invoice can be pulled up on demand.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { fetchInvoicePdf } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
    const docRaw = req.nextUrl.searchParams.get('doc') || id;
    const doc = docRaw.replace(/[^a-zA-Z0-9_-]/g, '');

    const pdf = await fetchInvoicePdf(id);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${doc || id}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
