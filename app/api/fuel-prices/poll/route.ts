// POST /api/fuel-prices/poll — admin-triggered "Check email now" for rack
// prices. Pulls the latest DTN/Sinclair rack-price email from the mailbox and
// upserts it into rack_prices, so the office can refresh prices on demand
// instead of pasting the email by hand.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { ingestRackPricesFromEmail } from '@/lib/rack-ingest';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const result = await ingestRackPricesFromEmail();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
