// PATCH  /api/haulers/loads/[id] — dispatch edits a load or moves its status.
// DELETE /api/haulers/loads/[id] — dispatch removes a load outright.
//
// Only office / admin reach either. The status values dispatch may set are
// listed explicitly: it can assign, complete or cancel a load, but it cannot
// answer on the hauler's behalf — 'accepted' and 'declined' come from the
// hauler's own route, so the record of who agreed to what stays honest.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { pickLoadEditable } from '@/lib/haulers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DISPATCHERS = ['office', 'admin', 'master_admin'];
const DISPATCH_STATUSES = ['offered', 'assigned', 'completed', 'cancelled'];

async function requireDispatcher() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 }) };
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !DISPATCHERS.includes(actor.role)) {
    return { error: NextResponse.json({ ok: false, error: 'not allowed' }, { status: 403 }) };
  }
  return { supabase, user };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireDispatcher();
  if (gate.error) return gate.error;
  const supabase = gate.supabase!;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch = pickLoadEditable(body);

  if (typeof body.status === 'string') {
    if (!DISPATCH_STATUSES.includes(body.status)) {
      return NextResponse.json(
        { ok: false, error: 'dispatch cannot set that status' },
        { status: 400 },
      );
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('hauler_loads')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, load: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const gate = await requireDispatcher();
  if (gate.error) return gate.error;
  const supabase = gate.supabase!;

  const { error } = await supabase.from('hauler_loads').delete().eq('id', params.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
