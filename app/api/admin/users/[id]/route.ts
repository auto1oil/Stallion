// PATCH  /api/admin/users/[id] — change a user's sign-in email.
// DELETE /api/admin/users/[id] — remove a user's login entirely.
//
// Both live behind the service role because they touch auth.users, which no
// browser session can reach. The profile edit (name, role, phone, company)
// stays a plain table update on the Users page — this route exists only for
// the two things that table can't do.
//
// Deleting is deliberately the loud option. The auth user goes, the profile
// cascades with it, and the person can no longer sign in. Their tickets
// survive — every work_orders reference is `on delete set null`, and the
// driver's name is stamped on the ticket as text — but their time-clock
// history cascades away with the profile. The UI says so before asking.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Who may act, and on whom. A plain admin manages the staff but cannot touch
// another admin or the master account — otherwise any admin could delete the
// owner and be the only login left standing.
async function gate(targetId: string) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 }) };
  }
  const { data: me } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return { error: NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 }) };
  }

  const db = createAdminClient();
  const { data: target } = await db
    .from('profiles').select('id, role, email').eq('id', targetId).maybeSingle();
  if (!target) {
    return { error: NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 }) };
  }
  if (['admin', 'master_admin'].includes(target.role) && me.role !== 'master_admin') {
    return { error: NextResponse.json(
      { ok: false, error: 'only the master admin can change another admin' },
      { status: 403 },
    ) };
  }
  return { db, meId: user.id, meRole: me.role as string, target };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (g.error) return g.error;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return NextResponse.json({ ok: false, error: 'enter a valid email' }, { status: 400 });
  }

  // email_confirm skips the "confirm your new address" mail — the admin
  // changing it IS the confirmation, and half the reason they're changing it
  // is that mail to the old address doesn't land.
  const { error: authErr } = await g.db!.auth.admin.updateUserById(params.id, {
    email,
    email_confirm: true,
  });
  if (authErr) {
    return NextResponse.json(
      {
        ok: false,
        error: /already/i.test(authErr.message)
          ? 'Another login already uses that email.'
          : authErr.message,
      },
      { status: 400 },
    );
  }

  // The profile keeps its own copy of the email; the two must not drift.
  await g.db!.from('profiles').update({ email }).eq('id', params.id);

  return NextResponse.json({ ok: true, email });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const g = await gate(params.id);
  if (g.error) return g.error;

  // Deleting yourself would strand the session and, for the last admin, the
  // whole app. Locking the door from the inside is never what was meant.
  if (params.id === g.meId) {
    return NextResponse.json(
      { ok: false, error: 'you cannot delete your own login' },
      { status: 400 },
    );
  }

  const { error } = await g.db!.auth.admin.deleteUser(params.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
