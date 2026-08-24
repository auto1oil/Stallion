// POST /api/quickbooks/void-invoice  — body { invoice_number }
//
// Admin only. Voids the matching invoice in QuickBooks (zeroes it to $0, keeps
// the number + audit trail). Called when an admin deletes an order in the app
// so the two stay in sync without permanently deleting the QB invoice.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { voidInvoiceByDocNumber } from '@/lib/quickbooks';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    let body: { invoice_number?: string };
    try { body = (await req.json()) as { invoice_number?: string }; } catch { body = {}; }
    const docNumber = (body.invoice_number || '').trim();
    if (!docNumber) return NextResponse.json({ ok: false, error: 'invoice_number required' }, { status: 400 });

    const result = await voidInvoiceByDocNumber(docNumber);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
