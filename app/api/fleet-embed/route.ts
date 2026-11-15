// GET  /api/fleet-embed — the One Glovebox fleet panel's embed link.
// POST /api/fleet-embed — an admin saves the company's Fleet ID.
//
// The fleet program (trips, IFTA miles, fuel, maintenance, registrations,
// repairs, documents) runs at oneglovebox.com and is framed into this app's
// Fleet tab. The Fleet ID lives in app_settings ('ogb_fleet_id'), which
// drivers cannot read directly — app_settings is admin-only — so this route
// hands every signed-in user the finished link instead.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = 'ogb_fleet_id';

// Per One Glovebox's embed hand-off: embed=1 turns on embedded mode, fleet=
// locks the panel to this company, brand/color skin it. The color is the
// Stallion logo red.
function embedUrl(fleetId: string): string {
  return `https://oneglovebox.com/app?embed=1&fleet=${encodeURIComponent(fleetId)}&brand=Stallion%20Tank&color=8E1414`;
}

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  const canConfigure = ['admin', 'master_admin'].includes(actor?.role || '');

  const { data } = await createAdminClient()
    .from('app_settings').select('value').eq('key', KEY).maybeSingle();
  const id = ((data as { value: string | null } | null)?.value || '').trim();

  return NextResponse.json({
    ok: true,
    configured: !!id,
    url: id ? embedUrl(id) : null,
    can_configure: canConfigure,
  });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!['admin', 'master_admin'].includes(actor?.role || '')) {
    return NextResponse.json({ ok: false, error: 'only an admin can set this up' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(body.fleet_id || '').trim();
  if (!/^[0-9a-f-]{10,}$/i.test(id)) {
    return NextResponse.json({
      ok: false,
      error: "That doesn't look like a Fleet ID. In One Glovebox: Settings, then Admin, then All users — it's on the owner's row, tap to copy.",
    }, { status: 400 });
  }

  const { error } = await createAdminClient()
    .from('app_settings').upsert([{ key: KEY, value: id }], { onConflict: 'key' });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, url: embedUrl(id) });
}
