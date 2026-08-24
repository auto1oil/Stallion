// POST /api/admin/run-deactivation — admin "Run inactivity check" button.
//
// Same pass as the nightly cron, but triggerable on demand by an admin so the
// inactive shading appears right away instead of waiting for the schedule.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { runDeactivationPass } from '@/lib/deactivate-customers';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }
    const result = await runDeactivationPass();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'server error' },
      { status: 500 },
    );
  }
}
