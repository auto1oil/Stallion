// GET /api/quickbooks/classes — admin-only list of every QuickBooks Class.
//
// Used to map each staff member to their QuickBooks class (and to let an admin see
// the full list, e.g. confirm Shelby's class exists). Active + inactive.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listClasses } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') {
    return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
  }
  try {
    const classes = await listClasses();
    const list = classes
      .map((c) => ({ id: c.Id, name: c.FullyQualifiedName || c.Name, active: c.Active !== false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ ok: true, classes: list });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
