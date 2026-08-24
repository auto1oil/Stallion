// POST /api/admin/card-charges/sync — admin-only. Pulls recent card charges
// from Plaid and matches them to receipts from the fuel/vehicle app. Safe to
// call with neither integration configured yet (returns configured:false flags
// so the UI can prompt for setup instead of erroring).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { syncCardCharges } from '@/lib/card-charges';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const result = await syncCardCharges();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'sync failed' },
      { status: 500 },
    );
  }
}
