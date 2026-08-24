// POST /api/salesman/request-visit
//
// Body: { salesman_profile_id: string, note?: string }
//
// The signed-in customer requests an in-person visit from the chosen
// sales rep. Creates a salesman_visit_requests row and pings the rep
// via the notifications table.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  type Body = { salesman_profile_id?: string; note?: string };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }
  if (!body.salesman_profile_id) {
    return NextResponse.json({ ok: false, error: 'salesman_profile_id required' }, { status: 400 });
  }

  const { data: me } = await supabase
    .from('profiles')
    .select('id, business_id')
    .eq('id', user.id)
    .single();
  if (!me) {
    return NextResponse.json({ ok: false, error: 'profile not found' }, { status: 404 });
  }

  const { data: request, error } = await supabase
    .from('salesman_visit_requests')
    .insert({
      customer_profile_id: me.id,
      business_id: me.business_id,
      salesman_profile_id: body.salesman_profile_id,
      customer_note: body.note?.trim() || null,
    })
    .select('id')
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  // A Postgres trigger handles fanning out the notification to the rep.
  return NextResponse.json({ ok: true, request_id: request.id });
}
