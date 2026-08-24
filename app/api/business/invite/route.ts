// POST   /api/business/invite          — owner creates an invite token
// DELETE /api/business/invite?id=...   — owner revokes a pending invite
//
// Caller must be the owner of a business (profile.is_business_owner = true
// with a business_id). The endpoint enforces the 3-member cap by checking
// current members + outstanding invites.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';

const MAX_MEMBERS = 3;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  }

  const { data: actor } = await supabase
    .from('profiles')
    .select('business_id, is_business_owner')
    .eq('id', user.id)
    .single();
  if (!actor || !actor.is_business_owner || !actor.business_id) {
    return NextResponse.json({ ok: false, error: 'only the business owner can invite' }, { status: 403 });
  }

  type Body = { email?: string; role_label?: 'Owner' | 'Manager' | 'Accountant' };
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }
  const roleLabel = body.role_label || 'Manager';

  // Count current members + outstanding invites
  const [{ count: memberCount }, { count: outstandingInvites }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', actor.business_id),
    supabase
      .from('business_invites')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', actor.business_id)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);
  const total = (memberCount || 0) + (outstandingInvites || 0);
  if (total >= MAX_MEMBERS) {
    return NextResponse.json(
      { ok: false, error: `This business already has ${MAX_MEMBERS} members or pending invites.` },
      { status: 400 },
    );
  }

  // Generate a 32-char base64url token — non-guessable.
  const token = randomBytes(24).toString('base64url');

  const { data: invite, error } = await supabase
    .from('business_invites')
    .insert({
      business_id: actor.business_id,
      invited_by_profile_id: user.id,
      invitee_email: body.email || null,
      invitee_role_label: roleLabel,
      token,
    })
    .select('id, token, expires_at')
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, invite });
}

export async function DELETE(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const url = new URL(req.url);
  const inviteId = url.searchParams.get('id');
  if (!inviteId) {
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  }
  // RLS bi_owner_manage ensures only the inviter (the owner) can delete.
  const { error } = await supabase
    .from('business_invites')
    .delete()
    .eq('id', inviteId)
    .is('accepted_at', null);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
