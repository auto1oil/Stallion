// POST /api/business/request-link
//
// Body: { business_id: string, claimed_name?: string, claimed_address?: string }
//
// A newly-signed-up customer is claiming an existing business. We create
// a pending business_link_requests row and notify every admin so they can
// approve or reject from /admin/customers.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  type Body = {
    business_id?: string;
    claimed_name?: string | null;
    claimed_address?: string | null;
  };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }
  if (!body.business_id) {
    return NextResponse.json({ ok: false, error: 'business_id required' }, { status: 400 });
  }

  // The requester must be a customer profile not yet linked to a business.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, business_id')
    .eq('id', user.id)
    .single();
  if (!profile || profile.role !== 'customer') {
    return NextResponse.json({ ok: false, error: 'only customers can request links' }, { status: 403 });
  }
  if (profile.business_id) {
    return NextResponse.json({ ok: false, error: 'already linked to a business' }, { status: 400 });
  }

  // Insert the pending request. The unique partial index on
  // (profile_id) where status='pending' blocks duplicates.
  const { data: request, error } = await supabase
    .from('business_link_requests')
    .insert({
      profile_id: user.id,
      business_id: body.business_id,
      claimed_name: body.claimed_name || null,
      claimed_address: body.claimed_address || null,
    })
    .select('id')
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Notify all admins/master_admins so the request surfaces immediately in
  // the bell — clicking it opens the For Approval tab to approve.
  const { data: admins } = await supabase
    .from('profiles')
    .select('id')
    .in('role', ['admin', 'master_admin']);
  if (admins && admins.length > 0) {
    await supabase.from('notifications').insert(
      admins.map((a) => ({
        recipient_id: a.id,
        kind: 'business_link_request',
        title: 'New customer needs approval',
        body: body.claimed_name
          ? `Claim: ${body.claimed_name}${body.claimed_address ? ` (${body.claimed_address})` : ''}`
          : 'A new customer signed up and is awaiting approval.',
        link: '/admin/customer-orders',
      })),
    );
  }

  return NextResponse.json({ ok: true, request_id: request.id });
}
