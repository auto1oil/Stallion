// POST /api/admin/plaid/link-token — admin-only. Returns a short-lived Plaid
// link_token the browser uses to open Plaid Link and connect a card.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createLinkToken, plaidCredsConfigured } from '@/lib/plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    if (!plaidCredsConfigured()) {
      return NextResponse.json(
        { ok: false, error: 'Plaid keys not set yet (PLAID_CLIENT_ID / PLAID_SECRET in Vercel).' },
        { status: 400 },
      );
    }
    const link_token = await createLinkToken(user.id);
    return NextResponse.json({ ok: true, link_token });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'could not start Plaid' },
      { status: 500 },
    );
  }
}
