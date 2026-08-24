// GET  /api/work-orders — list tickets the caller is allowed to see.
// POST /api/work-orders — create a ticket (crew, office, admin).
//
// Reads go through the caller's own session so RLS decides what they see:
// crew see their own, contractors their crews', the funder every ticket, and
// office/admin everything. Writes are narrowed to the editable columns here so
// a client can never set a status or an approval stamp by posting it.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { pickEditable } from '@/lib/work-orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CREATORS = ['driver', 'mechanic', 'contractor', 'office', 'admin', 'master_admin'];

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const jobNumber = url.searchParams.get('job_number');
  const mine = url.searchParams.get('mine') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);

  let query = supabase
    .from('work_orders')
    .select('*')
    .order('job_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  // `status` accepts a comma-separated list so a screen can ask for one bucket
  // ("submitted") or a stage of the chain ("office_approved,funds_approved").
  if (status) {
    const wanted = status.split(',').map((s) => s.trim()).filter(Boolean);
    query = wanted.length > 1 ? query.in('status', wanted) : query.eq('status', wanted[0]);
  }
  if (jobNumber) query = query.eq('job_number', jobNumber);
  if (mine) query = query.eq('submitted_by', user.id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, work_orders: data || [] });
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !CREATORS.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'not allowed to create tickets' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ticket is fine — it's a draft */ }

  const row = pickEditable(body);
  const submit = body.submit === true;

  const { data, error } = await supabase
    .from('work_orders')
    .insert({
      ...row,
      submitted_by: user.id,
      status: submit ? 'submitted' : 'draft',
      submitted_at: submit ? new Date().toISOString() : null,
    })
    .select('*')
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, work_order: data });
}
