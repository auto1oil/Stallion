// GET /api/business/search?q=<query>
//
// Used on the customer signup page when an existing customer is trying to
// find their business in the imported QB list. Returns at most 20 matches
// with only safe columns (id, name, address) — never qb_customer_id or
// internal notes. Auth-gated to authenticated users.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) {
    return NextResponse.json({ ok: true, results: [] });
  }

  const { data, error } = await supabase.rpc('search_businesses', { query: q });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, results: data || [] });
}
