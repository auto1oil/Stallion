// GET /api/quote-products — the full product catalog for building a quote,
// readable by any signed-in staff member. inventory_items RLS limits non-admins
// to active, non-admin_only rows, so salesmen would otherwise miss products they
// can legitimately quote. Read server-side (service role) and return the whole
// list (name, description, packaging, retail price — never cost).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!me || me.role === 'customer') {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from('inventory_items')
    .select('id, qb_name, description, packaging, retail_price')
    .order('qb_name')
    .limit(5000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data || [] });
}
