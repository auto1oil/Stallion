// POST /api/quickbooks/import-items — admin "Sync items from QuickBooks".
//
// Pulls the active QuickBooks item catalog and inserts any items missing from
// inventory_items (insert-only — existing items keep their managed cost/retail/
// packaging). Makes sure every product, fee, and tax item is available for the
// vendor-bill line→item mapping dropdown.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { importQbItems } from '@/lib/inventory-sync';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const result = await importQbItems();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
