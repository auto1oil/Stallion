// GET /api/commissions?from=YYYY-MM-DD&to=YYYY-MM-DD[&rep=<id>]
//
// Salesman commission report. Admins/master admins see every salesman (or one
// via ?rep); a salesman only ever sees their own. Computed from QuickBooks
// invoices + item costs (see lib/commissions). Defaults to the current month.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { computeCommissions } from '@/lib/commissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function monthRange(): { from: string; to: string } {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  const role = me?.role;
  if (!role || !['salesman', 'admin', 'master_admin'].includes(role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  const url = new URL(req.url);
  const def = monthRange();
  const from = url.searchParams.get('from') || def.from;
  const to = url.searchParams.get('to') || def.to;
  // Salesmen are locked to their own numbers; admins may filter to one rep.
  const rep = role === 'salesman' ? user.id : (url.searchParams.get('rep') || null);

  try {
    const result = await computeCommissions(createAdminClient(), from, to, rep);
    return NextResponse.json({ ok: true, from, to, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
