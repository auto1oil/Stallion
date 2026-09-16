// GET  /api/haulers/factoring-link — where the caller's company's Auto 1
//        Funding link stands (asked live; falls back to the cached answer).
// POST /api/haulers/factoring-link — request the link. Company login only;
//        the request lands on the factoring app's admin queue.
//
// Server-side because the factoring API key never reaches a browser, and
// because the cached status columns on haulers are guarded against the
// company writing them itself.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requestFactoringLink, checkFactoringLink } from '@/lib/factoring';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function resolveHauler(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 }) };
  const { data: actor } = await supabase
    .from('profiles').select('role, hauler_id').eq('id', user.id).single();

  // Staff may look at any company (?hauler_id=…); a hauler-side login is
  // pinned to its own.
  const url = new URL(req.url);
  const asked = url.searchParams.get('hauler_id');
  const isStaff = ['office', 'admin', 'master_admin'].includes(actor?.role || '');
  const haulerId = actor?.hauler_id || (isStaff ? asked : null);
  if (!haulerId) {
    return { error: NextResponse.json({ ok: false, error: 'no hauling company on this login' }, { status: 403 }) };
  }
  return { haulerId, role: actor?.role || '', ownCompany: !!actor?.hauler_id };
}

export async function GET(req: Request) {
  const r = await resolveHauler(req);
  if ('error' in r) return r.error;
  const db = createAdminClient();
  const result = await checkFactoringLink(db, r.haulerId!);
  return NextResponse.json({ ok: true, status: result.status, live: result.live, note: result.error || null });
}

export async function POST(req: Request) {
  const r = await resolveHauler(req);
  if ('error' in r) return r.error;
  // The company login owns the request — a driver doesn't sign the company
  // up for factoring, and staff don't request on a company's behalf.
  if (r.role !== 'hauler') {
    return NextResponse.json({ ok: false, error: 'only the company login can request the link' }, { status: 403 });
  }
  const db = createAdminClient();
  const result = await requestFactoringLink(db, r.haulerId!);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, status: result.status });
}
