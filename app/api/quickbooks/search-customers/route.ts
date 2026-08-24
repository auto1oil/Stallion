// GET /api/quickbooks/search-customers?q=... — admin-only. Live search of active
// QuickBooks customers, for the "re-link customer" picker.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { searchCustomers } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  const q = new URL(req.url).searchParams.get('q') || '';
  try {
    const custs = await searchCustomers(q);
    return NextResponse.json({
      ok: true,
      customers: custs.map((c) => ({ id: c.Id, name: c.DisplayName || '', email: c.PrimaryEmailAddr?.Address || null })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks search failed' }, { status: 502 });
  }
}
