// POST /api/admin/users — admin-only: create a staff login (driver/contractor/
// admin) without leaving the app. Uses the service-role key to create the auth
// user; the handle_new_user trigger makes the profile, then we set role/phone.
// Returns a temporary password to hand to the new user (they're forced to
// change it on first sign-in).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const ROLES = ['driver', 'contractor', 'funder', 'admin', 'office', 'mechanic', 'labor'] as const;
type NewRole = (typeof ROLES)[number];

function tempPassword(): string {
  // Readable temp password, e.g. "Auto1-7gk2qd".
  return `Auto1-${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!me || (me.role !== 'admin' && me.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'Admins only.' }, { status: 403 });
  }

  let body: { email?: string; full_name?: string; role?: string; phone?: string };
  try { body = await req.json(); } catch { body = {}; }

  const email = (body.email || '').trim().toLowerCase();
  const full_name = (body.full_name || '').trim();
  const phone = (body.phone || '').trim();
  const role: NewRole = ROLES.includes(body.role as NewRole) ? (body.role as NewRole) : 'driver';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'A valid email is required.' }, { status: 400 });
  }

  const admin = createAdminClient();
  const password = tempPassword();
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // they can sign in immediately
    user_metadata: full_name ? { full_name } : undefined,
  });
  if (error || !created?.user) {
    const msg = /already.*registered|exists/i.test(error?.message || '')
      ? 'That email already has an account.'
      : (error?.message || 'Could not create the user.');
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  // The handle_new_user trigger created the profile (default driver). Apply the
  // chosen role + details, and keep the force-password-change flag on.
  const { error: upErr } = await admin
    .from('profiles')
    .update({ role, full_name: full_name || null, phone: phone || null, must_change_password: true })
    .eq('id', created.user.id);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, email, password, role });
}
