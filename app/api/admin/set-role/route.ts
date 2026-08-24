// POST /api/admin/set-role — admin changes a user's role (e.g. a customer who
// is really staff). Body: { user_id, role }.
//
// Admins/master admins only. Granting master_admin requires a master admin.
// Runs with the service-role client.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const ROLES = ['customer', 'driver', 'salesman', 'admin', 'master_admin', 'office', 'mechanic', 'labor'] as const;
type AppRole = (typeof ROLES)[number];

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const userId = body.user_id as string | undefined;
    const role = body.role as AppRole | undefined;
    if (!userId || !role || !ROLES.includes(role)) {
      return NextResponse.json({ ok: false, error: 'user_id and a valid role are required' }, { status: 400 });
    }
    // Only a master admin can grant (or revoke) master_admin.
    if ((role === 'master_admin') && me.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'only a master admin can grant master admin' }, { status: 403 });
    }

    const db = createAdminClient();
    const { error } = await db.from('profiles').update({ role }).eq('id', userId);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
