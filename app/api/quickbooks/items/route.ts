// GET /api/quickbooks/items
//
// Returns every active item in the connected QuickBooks company. Used by the
// Work Orders setup screen to pick the item every approved ticket bills
// against, and by the admin QuickBooks mapping screens.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listAllItems } from '@/lib/quickbooks';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !['office', 'admin', 'master_admin'].includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'office or admin required' }, { status: 403 });
  }

  try {
    const items = await listAllItems();
    return NextResponse.json({
      ok: true,
      items: items.map((i) => ({
        id: i.Id,
        name: i.Name,
        unit_price: i.UnitPrice ?? null,
        type: i.Type ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || 'Failed to list QB items' }, { status: 502 });
  }
}
