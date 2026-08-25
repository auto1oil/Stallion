// GET  /api/haulers/loads — list loads the caller is allowed to see.
// POST /api/haulers/loads — offer a load to a hauler (office / admin only).
//
// Reads go through the caller's own session so RLS decides what they see: a
// hauler sees its own company's loads, office and admin see every load.
//
// POST is where a load reaches a hauler, so it is also where the hauler's
// people get told. The notification fan-out uses the service role because it
// writes rows owned by other users — a hauler's own session could never
// insert a notification addressed to itself.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { sendPushToUsers } from '@/lib/webpush';
import { pickLoadEditable, loadSummary, type HaulerLoad } from '@/lib/haulers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DISPATCHERS = ['office', 'admin', 'master_admin'];

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const haulerId = url.searchParams.get('hauler_id');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  let query = supabase
    .from('hauler_loads')
    .select('*')
    .order('job_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) query = query.eq('status', status);
  if (haulerId) query = query.eq('hauler_id', haulerId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, loads: data || [] });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles')
    .select('role, full_name, email')
    .eq('id', user.id)
    .single();
  if (!actor || !DISPATCHERS.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'not allowed to dispatch loads' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch = pickLoadEditable(body);
  if (!patch.hauler_id) {
    return NextResponse.json({ ok: false, error: 'pick a hauler' }, { status: 400 });
  }

  // 'offered' is the only status a new load may start in. The office assigning
  // directly still goes through the hauler's accept, so nobody is put on a job
  // without having seen it.
  const { data: load, error } = await supabase
    .from('hauler_loads')
    .insert({ ...patch, status: 'offered', assigned_by: user.id })
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  const by = (actor.full_name || actor.email || 'Dispatch') as string;
  await notifyHauler(load as HaulerLoad, by);

  return NextResponse.json({ ok: true, load });
}

// Tell everyone who signs in for that hauler company that a load is waiting.
// Best-effort: a push or notification failure must not lose the load.
async function notifyHauler(load: HaulerLoad, by: string) {
  try {
    const db = createAdminClient();
    const { data: people } = await db
      .from('profiles')
      .select('id')
      .eq('hauler_id', load.hauler_id);
    const ids = ((people as { id: string }[]) || []).map((p) => p.id);
    if (ids.length === 0) return;

    const summary = loadSummary(load);
    const title = 'New load offered';
    await db.from('notifications').insert(
      ids.map((id) => ({
        recipient_id: id,
        kind: 'hauler_load_offered',
        title: summary ? `${title} — ${summary}` : title,
        body: `Offered by ${by}. Accept or decline from your loads.`,
        link: `/hauler`,
      })),
    );
    await sendPushToUsers(ids, {
      title,
      body: summary || 'A load is waiting for your response.',
      url: '/hauler',
    });
  } catch {
    /* ignore — the load is placed either way */
  }
}
