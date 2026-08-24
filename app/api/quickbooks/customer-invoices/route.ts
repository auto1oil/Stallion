// GET /api/quickbooks/customer-invoices?businessId=… — admin-only.
//
// Lists a customer's invoices straight from QuickBooks (newest first) so the
// admin can browse and pull up any invoice's PDF later. Resolves the QB customer
// id from the business so the client never needs it.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listCustomerInvoices } from '@/lib/quickbooks';

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

    const businessId = req.nextUrl.searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ ok: false, error: 'businessId required' }, { status: 400 });

    const { data: biz } = await supabase
      .from('businesses').select('qb_customer_id').eq('id', businessId).maybeSingle();
    const qbId = (biz as { qb_customer_id: string | null } | null)?.qb_customer_id;
    if (!qbId) return NextResponse.json({ ok: true, invoices: [], unlinked: true });

    const invoices = await listCustomerInvoices(String(qbId));
    return NextResponse.json({ ok: true, invoices });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
