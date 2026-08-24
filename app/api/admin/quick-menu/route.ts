// POST /api/admin/quick-menu — admin-only Quick-menu (products table) writes.
//
// The products table's RLS blocks browser writes, so all create/update/remove
// goes through here with the service-role client. Actions:
//   add_from_item { inventory_item_id, category, size } — create a Quick-menu
//      product from an inventory item and link the item to it (price flows).
//   update        { id, weights, container_sizes }       — edit a product.
//   remove        { id }                                  — soft-delete (active=false).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const db = createAdminClient();

    if (body.action === 'add_from_item') {
      const { inventory_item_id, category, size } = body as { inventory_item_id?: string; category?: string; size?: string };
      const cat = (category || '').trim();
      if (!inventory_item_id || !cat) {
        return NextResponse.json({ ok: false, error: 'inventory_item_id and category are required' }, { status: 400 });
      }
      const { data: item } = await db
        .from('inventory_items').select('description, qb_name, packaging').eq('id', inventory_item_id).maybeSingle();
      if (!item) return NextResponse.json({ ok: false, error: 'inventory item not found' }, { status: 404 });
      const name = ((item.description as string) || (item.qb_name as string) || '').trim();
      const sz = (size || '').trim();

      // Sort to the end of its category.
      const { data: maxRows } = await db
        .from('products').select('sort_order').eq('category', cat)
        .order('sort_order', { ascending: false }).limit(1);
      const nextSort = (((maxRows?.[0] as { sort_order?: number })?.sort_order) ?? 0) + 1;

      const { data: prod, error } = await db.from('products').insert({
        name, category: cat, active: true, sort_order: nextSort,
        weights: [], container_sizes: sz ? [sz] : [],
      }).select('id').single();
      if (error || !prod) return NextResponse.json({ ok: false, error: error?.message || 'could not create product' }, { status: 500 });

      // Link the inventory item so its retail price flows to the Quick list.
      await db.from('inventory_items')
        .update({ match_product_id: (prod as { id: string }).id, match_weight: null, match_container_size: sz || null })
        .eq('id', inventory_item_id);
      return NextResponse.json({ ok: true, product_id: (prod as { id: string }).id });
    }

    if (body.action === 'update') {
      const { id, weights, container_sizes } = body as { id?: string; weights?: string[]; container_sizes?: string[] };
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
      const patch: Record<string, unknown> = {};
      if (Array.isArray(weights)) patch.weights = weights;
      if (Array.isArray(container_sizes)) patch.container_sizes = container_sizes;
      const { error } = await db.from('products').update(patch).eq('id', id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'remove') {
      const { id } = body as { id?: string };
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
      const { error } = await db.from('products').update({ active: false }).eq('id', id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
