// GET /api/admin/card-charges/qb-accounts — list the QuickBooks credit-card
// accounts, so an admin can pick which one(s) card charges sync from.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listCreditCardAccounts } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const accounts = await listCreditCardAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'failed to list accounts' },
      { status: 500 },
    );
  }
}
