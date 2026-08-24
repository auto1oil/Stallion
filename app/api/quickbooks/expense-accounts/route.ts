// GET /api/quickbooks/expense-accounts — admin: active expense accounts for the
// PO-bill default-account picker.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { listExpenseAccounts } from '@/lib/quickbooks-vendors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }
  try {
    const accounts = await listExpenseAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QB accounts failed' }, { status: 502 });
  }
}
