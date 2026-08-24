// POST /api/quickbooks/sync-inventory — admin-only manual trigger of the
// inventory-level sync (also runs nightly via /api/cron/sync-inventory).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { syncInventoryLevels } from '@/lib/inventory-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  try {
    const result = await syncInventoryLevels();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'QuickBooks sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
