// POST /api/quickbooks/sync-balances
//
// Admin-triggered refresh of cached QB balances on every Business with a
// qb_customer_id. The heavy lifting lives in lib/quickbooks#syncQbBalances so
// the nightly cron (/api/cron/sync-balances) can reuse it.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { syncQbBalances } from '@/lib/quickbooks';

// Pulling balances + open invoices and writing 100+ businesses can exceed
// the default 10s.
export const maxDuration = 60;

export async function POST() {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  try {
    const { synced, total } = await syncQbBalances(supabase);
    return NextResponse.json({ ok: true, synced, total });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'sync failed' },
      { status: 502 },
    );
  }
}
