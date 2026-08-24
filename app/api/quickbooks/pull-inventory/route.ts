// POST /api/quickbooks/pull-inventory — admin "Pull from QuickBooks".
//
// Refreshes cost, retail price, and stock on hand for every inventory item from
// QuickBooks (the source of truth), and imports any items the app doesn't have.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { syncInventoryFromQuickBooks } from '@/lib/inventory-sync';

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
    const result = await syncInventoryFromQuickBooks();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
