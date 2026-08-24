// POST /api/admin/order-set-customer — admin-only. Reassign a pending customer
// order to a different customer (fixes staff picking the wrong business
// before it's invoiced). Refuses once the order has been invoiced/dispatched.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const orderId = String(body.order_id || '');
  const customerId = String(body.customer_id || '');
  if (!orderId || !customerId) {
    return NextResponse.json({ ok: false, error: 'order_id and customer_id required' }, { status: 400 });
  }

  const db = createAdminClient();
  const { data: order } = await db
    .from('customer_orders')
    .select('id, invoiced_at, dispatched_order_id')
    .eq('id', orderId)
    .single();
  if (!order) return NextResponse.json({ ok: false, error: 'order not found' }, { status: 404 });
  if (order.invoiced_at || order.dispatched_order_id) {
    return NextResponse.json({ ok: false, error: 'This order is already invoiced/dispatched — the customer can no longer be changed.' }, { status: 409 });
  }

  const { data: cust } = await db.from('profiles').select('id, role').eq('id', customerId).single();
  if (!cust || cust.role !== 'customer') {
    return NextResponse.json({ ok: false, error: 'Pick a valid customer account.' }, { status: 400 });
  }

  const { error } = await db.from('customer_orders').update({ customer_id: customerId }).eq('id', orderId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
