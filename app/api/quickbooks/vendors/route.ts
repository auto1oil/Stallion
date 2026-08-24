// GET /api/quickbooks/vendors?q=<term> — admin vendor typeahead (PO → bill).

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { searchVendors, createVendor } from '@/lib/quickbooks-bills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, status: 401 as const, error: 'not signed in' };
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return { ok: false as const, status: 403 as const, error: 'admin required' };
  }
  return { ok: true as const };
}

// POST — create a new QuickBooks vendor from the PO "New vendor" form.
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  let body: { name?: string; contactName?: string; phone?: string; email?: string; address?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  if (!body.name?.trim()) return NextResponse.json({ ok: false, error: 'Vendor name is required.' }, { status: 400 });
  try {
    const v = await createVendor({
      name: body.name, contactName: body.contactName, phone: body.phone, email: body.email, address: body.address,
    });
    return NextResponse.json({ ok: true, vendor: { id: v.Id, name: v.DisplayName } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Could not create vendor' }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  if (q.length < 1) return NextResponse.json({ ok: true, vendors: [] });
  try {
    const rows = await searchVendors(q);
    return NextResponse.json({ ok: true, vendors: rows.map((v) => ({ id: v.Id, name: v.DisplayName })) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QB vendor search failed' }, { status: 502 });
  }
}
