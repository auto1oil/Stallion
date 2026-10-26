// POST /api/factoring/ping — test the saved Auto 1 Funding connection.
//
// Admin only; the key never reaches the browser. Probes the funding app's
// link-status with a hauler id that can't exist, which proves the address,
// the key and the source without creating anything over there. Always tests
// the SAVED settings — what the server will actually use — not whatever is
// sitting unsaved in the form.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { pingFactoring } from '@/lib/factoring';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, message: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !['admin', 'master_admin'].includes(actor.role)) {
    return NextResponse.json({ ok: false, message: 'admin only' }, { status: 403 });
  }

  const result = await pingFactoring(createAdminClient());
  return NextResponse.json(result);
}
