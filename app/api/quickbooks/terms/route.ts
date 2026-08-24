// GET /api/quickbooks/terms — list of QuickBooks sales terms for the
// order-placement dropdown. Staff only (reps/admins place orders).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listSalesTerms } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (!me || me.role === 'customer') {
      return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
    }
    const terms = await listSalesTerms();
    return NextResponse.json({ ok: true, terms });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
