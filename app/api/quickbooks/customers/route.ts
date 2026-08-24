// GET /api/quickbooks/customers?q=<term> — admin customer typeahead.
//
// Runs the QB query directly (rather than via searchCustomers, which swallows
// query errors and returns []) so a real failure surfaces to the UI instead of
// looking like "no matches".

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { qbFetch } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type QBCustomerRow = { Id: string; DisplayName: string; Active?: boolean };

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
  const { data: actor } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 403 });
  }

  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  if (q.length < 1) return NextResponse.json({ ok: true, customers: [] });

  // QuickBooks' query language does NOT support OR, and its LIKE is
  // case-sensitive — so run a separate single-LIKE query per case variant and
  // merge. Escape single quotes for the QBO query language.
  const esc = (s: string) => s.replace(/'/g, "''");
  const variants = Array.from(new Set([q, q.toLowerCase(), q.toUpperCase(), q.charAt(0).toUpperCase() + q.slice(1).toLowerCase()]));

  try {
    const batches = await Promise.all(variants.map((v) => {
      const query = `select Id, DisplayName from Customer where DisplayName like '%${esc(v)}%' order by DisplayName maxresults 30`;
      return qbFetch<{ QueryResponse?: { Customer?: QBCustomerRow[] } }>(`/query?query=${encodeURIComponent(query)}`);
    }));
    const seen = new Set<string>();
    const customers: { id: string; name: string }[] = [];
    for (const res of batches) {
      for (const c of res.QueryResponse?.Customer || []) {
        if (c.Active === false || seen.has(c.Id)) continue;
        seen.add(c.Id);
        customers.push({ id: c.Id, name: c.DisplayName });
      }
    }
    customers.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ ok: true, customers: customers.slice(0, 30) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'QuickBooks customer search failed' }, { status: 502 });
  }
}
