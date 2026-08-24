// GET /api/admin/qb-invoice-debug?customer=PartsCo[&doc=3070]
//
// Admin-only diagnostic. Reads the customer's recent invoices straight from
// QuickBooks and shows, line by line, exactly what the commission engine sees:
// item name/id, quantity, unit price, amount, the salesman Class, and the cost
// it resolves (QB PurchaseCost or app inventory) — so we can see precisely why
// a line's gross profit is off, without re-creating anything.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { qbFetch, listAllItems, reFindActiveCustomer, getActiveCustomer } from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const bareName = (s: string) => {
  const t = (s || '').toLowerCase().trim();
  const i = t.lastIndexOf(':');
  return (i >= 0 ? t.slice(i + 1) : t).trim();
};

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const admin = createAdminClient();
    const customer = req.nextUrl.searchParams.get('customer');
    const doc = req.nextUrl.searchParams.get('doc');

    // With a doc number we can look the invoice up directly — no customer
    // needed. Only resolve a customer when no doc is given.
    let cust: { Id: string; DisplayName?: string } | null = null;
    if (!doc) {
      cust = await reFindActiveCustomer({ name: customer || 'PartsCo' });
      if (!cust) return NextResponse.json({ ok: false, error: `no active QuickBooks customer matched "${customer || 'PartsCo'}"` });
    }

    // Cost maps (same sources the commission engine uses).
    const items = await listAllItems();
    const qbCostById = new Map<string, number>();
    const fqnById = new Map<string, string>();
    for (const it of items) {
      if (it.PurchaseCost != null) qbCostById.set(it.Id, Number(it.PurchaseCost));
      fqnById.set(it.Id, it.FullyQualifiedName || it.Name || '');
    }
    const invCostByName = new Map<string, number>();
    const { data: invRows } = await admin.from('inventory_items').select('qb_name, cost');
    for (const r of (invRows as { qb_name: string | null; cost: number | null }[]) || []) {
      if (r.cost == null || !(Number(r.cost) > 0) || !r.qb_name) continue;
      invCostByName.set(r.qb_name.trim().toLowerCase(), Number(r.cost));
      invCostByName.set(bareName(r.qb_name), Number(r.cost));
    }

    const where = doc
      ? `DocNumber = '${doc.replace(/'/g, "''")}'`
      : `CustomerRef = '${cust!.Id}'`;
    const q = `select * from Invoice where ${where} orderby TxnDate desc maxresults 5`;
    const res = await qbFetch<{ QueryResponse: { Invoice?: Array<Record<string, unknown>> } }>(
      `/query?query=${encodeURIComponent(q)}`,
    );
    const invoices = res.QueryResponse.Invoice || [];

    const out = invoices.map((inv) => {
      const lines = ((inv.Line as Array<Record<string, unknown>>) || [])
        .filter((l) => l.DetailType === 'SalesItemLineDetail')
        .map((l) => {
          const d = (l.SalesItemLineDetail as Record<string, unknown>) || {};
          const ref = (d.ItemRef as { value?: string; name?: string }) || {};
          const cls = (d.ClassRef as { name?: string }) || {};
          const id = ref.value || '';
          const name = ref.name || '';
          const qbCost = qbCostById.get(id);
          const invCost = invCostByName.get((name || '').toLowerCase()) ?? invCostByName.get(bareName(name))
            ?? invCostByName.get((fqnById.get(id) || '').toLowerCase()) ?? invCostByName.get(bareName(fqnById.get(id) || ''));
          const unitCost = qbCost ?? invCost ?? 0;
          const qty = Number(d.Qty ?? 0);
          const amount = Number(l.Amount ?? 0);
          const lineCost = Math.round(unitCost * qty * 100) / 100;
          const margin = Math.round((amount - lineCost) * 100) / 100;
          return {
            item: name,
            itemId: id,
            fqn: fqnById.get(id) || null,
            qty: d.Qty ?? null,
            unitPrice: d.UnitPrice ?? null,
            amount: l.Amount ?? null,
            class: cls.name ?? null,
            qbPurchaseCost: qbCost ?? null,
            inventoryCost: invCost ?? null,
            resolvedUnitCost: unitCost,
            lineCost,
            margin,
            marginPct: amount > 0 ? Math.round((margin / amount) * 1000) / 10 : null,
            costSource: qbCost != null ? 'quickbooks' : invCost != null ? 'inventory' : 'none',
          };
        });
      const totalCost = Math.round(lines.reduce((s, l) => s + l.lineCost, 0) * 100) / 100;
      const totalAmt = Number(inv.TotalAmt ?? 0);
      return {
        docNumber: inv.DocNumber ?? null,
        txnDate: inv.TxnDate ?? null,
        customer: (inv.CustomerRef as { name?: string })?.name ?? null,
        totalAmt: inv.TotalAmt ?? null,
        totalCost,
        totalMargin: Math.round((totalAmt - totalCost) * 100) / 100,
        lines,
      };
    });

    return NextResponse.json({
      ok: true,
      customerResolved: cust ? { id: cust.Id, name: cust.DisplayName } : null,
      invoices: out,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
