// POST /api/business/reject-link
//
// Body: { request_id: string, note?: string }
//
// Admin-only. Marks a pending business_link_request as rejected and
// notifies the customer with the optional admin note.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  type Body = { request_id?: string; note?: string };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }
  if (!body.request_id) {
    return NextResponse.json({ ok: false, error: 'request_id required' }, { status: 400 });
  }

  const { data: request, error: loadErr } = await supabase
    .from('business_link_requests')
    .select('id, profile_id, status')
    .eq('id', body.request_id)
    .single();
  if (loadErr || !request) {
    return NextResponse.json({ ok: false, error: 'request not found' }, { status: 404 });
  }
  if (request.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `request already ${request.status}` }, { status: 400 });
  }

  await supabase
    .from('business_link_requests')
    .update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
      reviewer_note: body.note || null,
    })
    .eq('id', request.id);

  await supabase.from('notifications').insert({
    recipient_id: request.profile_id,
    kind: 'business_link_rejected',
    title: 'Account link request denied',
    body: body.note ? body.note : 'Contact us if you think this is a mistake.',
    link: '/shop/account',
  });

  return NextResponse.json({ ok: true });
}
