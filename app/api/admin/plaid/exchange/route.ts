// POST /api/admin/plaid/exchange — admin-only. Exchanges the public_token from a
// successful Plaid Link for a permanent access token and stores it in
// plaid_items. Body: { public_token, institution_name? }.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { exchangePublicToken } from '@/lib/plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const publicToken = body.public_token as string | undefined;
    if (!publicToken) return NextResponse.json({ ok: false, error: 'missing public_token' }, { status: 400 });

    const { accessToken, itemId } = await exchangePublicToken(publicToken);
    const db = createAdminClient();
    const { error } = await db.from('plaid_items').upsert(
      { item_id: itemId, access_token: accessToken, institution_name: (body.institution_name as string) || null },
      { onConflict: 'item_id' },
    );
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'could not link card' },
      { status: 500 },
    );
  }
}
