// POST /api/business/approve-link
//
// Body: { request_id: string }
//
// Admin-only. Approves a pending business_link_request: sets the new
// profile's business_id and notifies the customer. The customer is NOT
// marked as is_business_owner — they're joining an existing business
// (whose original signup user already holds owner).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  // Caller must be admin or master_admin.
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  type Body = { request_id?: string };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }
  if (!body.request_id) {
    return NextResponse.json({ ok: false, error: 'request_id required' }, { status: 400 });
  }

  // Load the request + verify it's still pending.
  const { data: request, error: loadErr } = await supabase
    .from('business_link_requests')
    .select('id, profile_id, business_id, status')
    .eq('id', body.request_id)
    .single();
  if (loadErr || !request) {
    return NextResponse.json({ ok: false, error: 'request not found' }, { status: 404 });
  }
  if (request.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `request already ${request.status}` }, { status: 400 });
  }

  // Link the profile to the business.
  const { error: profErr } = await supabase
    .from('profiles')
    .update({ business_id: request.business_id })
    .eq('id', request.profile_id);
  if (profErr) {
    return NextResponse.json({ ok: false, error: `link failed: ${profErr.message}` }, { status: 500 });
  }

  // Mark the request approved.
  await supabase
    .from('business_link_requests')
    .update({
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
    })
    .eq('id', request.id);

  // Tell the customer their request was approved.
  await supabase.from('notifications').insert({
    recipient_id: request.profile_id,
    kind: 'business_link_approved',
    title: 'Your account is linked',
    body: 'You can now place orders against your existing business account.',
    link: '/shop',
  });

  return NextResponse.json({ ok: true });
}
