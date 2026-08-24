// GET /api/staff/inventory — read-only stock list for salesmen + drivers.
//
// Shows description, quantity on hand, and RETAIL price only — never cost.
// Assembled server-side (staff aren't covered by the inventory RLS). Returns
// the entire active inventory — including items flagged admin_only — so every
// staff role can see the full catalog (cost stays hidden either way).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!me || !['driver', 'mechanic', 'salesman', 'admin', 'master_admin'].includes(me.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  const db = createAdminClient();
  // NOTE: cost is deliberately NOT selected — staff see retail + qty only.
  // The match_* fields let the order screen map retail prices onto catalog
  // products; they carry no cost, so they're safe for every staff role.
  const { data } = await db
    .from('inventory_items')
    .select('id, description, qb_name, packaging, qty_on_hand, retail_price, match_product_id, match_weight, match_container_size')
    .eq('active', true)
    .order('packaging')
    .order('description');

  const items = (data || []).map((r) => {
    const row = r as {
      id: string; description: string | null; qb_name: string; packaging: string | null;
      qty_on_hand: number | null; retail_price: number | null;
      match_product_id: string | null; match_weight: string | null; match_container_size: string | null;
    };
    return {
      id: row.id,
      name: row.description || row.qb_name,
      description: row.description,
      qb_name: row.qb_name,
      packaging: row.packaging,
      qty_on_hand: row.qty_on_hand,
      retail_price: row.retail_price,
      match_product_id: row.match_product_id,
      match_weight: row.match_weight,
      match_container_size: row.match_container_size,
    };
  });
  return NextResponse.json({ ok: true, items });
}
