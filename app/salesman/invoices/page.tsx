'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Invoices a salesman placed (they submitted the order or are its sales rep) or
// is the salesman for (assigned rep on the customer's business). Built from the
// customer_orders they're attributed to, joined to the dispatched order that
// carries the QuickBooks invoice number + PDF.

type Row = {
  id: string;
  customer: string;
  invoice_number: string | null;
  invoice_pdf_path: string | null;
  signed_pdf_path: string | null;
  date: string | null;
  status: string;
  delivered: boolean;
  reason: string; // why it's attributed to me
};

const STATUS_LABEL: Record<string, string> = {
  warehouse: 'In warehouse',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

export default function SalesmanInvoicesPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const me = user.id;

      // Customers whose business is assigned to me → "salesman for".
      const { data: myBiz } = await supabase.from('businesses').select('id').eq('assigned_sales_rep_id', me);
      const bizIds = (myBiz as { id: string }[] | null)?.map((b) => b.id) || [];
      let myCustomerIds: string[] = [];
      if (bizIds.length) {
        const { data: custs } = await supabase.from('profiles').select('id').eq('role', 'customer').in('business_id', bizIds);
        myCustomerIds = (custs as { id: string }[] | null)?.map((c) => c.id) || [];
      }

      // customer_orders attributed to me that have been dispatched (→ an invoice).
      const ors = [`sales_rep_id.eq.${me}`, `submitted_by_id.eq.${me}`];
      if (myCustomerIds.length) ors.push(`customer_id.in.(${myCustomerIds.join(',')})`);
      const { data: co } = await supabase
        .from('customer_orders')
        .select('id, customer_id, sales_rep_id, submitted_by_id, dispatched_order_id, created_at, customer:profiles!customer_orders_customer_id_fkey(business_name, business:businesses!profiles_business_id_fkey(name))')
        .not('dispatched_order_id', 'is', null)
        .or(ors.join(','))
        .order('created_at', { ascending: false });

      const coList = (co as unknown as Array<{
        id: string; customer_id: string | null; sales_rep_id: string | null; submitted_by_id: string | null;
        dispatched_order_id: string | null;
        customer: { business_name: string | null; business: { name: string | null } | null } | null;
      }>) || [];

      const orderIds = Array.from(new Set(coList.map((c) => c.dispatched_order_id).filter(Boolean) as string[]));
      const ordersById = new Map<string, { invoice_number: string | null; invoice_pdf_path: string | null; signed_pdf_path: string | null; date: string | null; status: string; delivered: boolean; customer: string }>();
      if (orderIds.length) {
        const { data: ords } = await supabase
          .from('orders')
          .select('id, invoice_number, invoice_pdf_path, signed_pdf_path, date, status, delivered, customer')
          .in('id', orderIds);
        for (const o of (ords as any[]) || []) ordersById.set(o.id, o);
      }

      // Standalone (admin-entered) orders credited directly to me.
      const { data: mine } = await supabase
        .from('orders')
        .select('id, invoice_number, invoice_pdf_path, signed_pdf_path, date, status, delivered, customer')
        .eq('sales_rep_id', me)
        .order('date', { ascending: false });

      const reasonFor = (c: typeof coList[number]) =>
        c.sales_rep_id === me ? 'You are the sales rep'
        : c.submitted_by_id === me ? 'You placed this order'
        : 'Your assigned customer';

      const seen = new Set<string>();
      const out: Row[] = [];
      for (const c of coList) {
        const ord = c.dispatched_order_id ? ordersById.get(c.dispatched_order_id) : null;
        if (!ord || seen.has(c.dispatched_order_id!)) continue;
        seen.add(c.dispatched_order_id!);
        out.push({
          id: c.dispatched_order_id!,
          customer: c.customer?.business?.name || c.customer?.business_name || ord.customer || 'Customer',
          invoice_number: ord.invoice_number,
          invoice_pdf_path: ord.invoice_pdf_path,
          signed_pdf_path: ord.signed_pdf_path,
          date: ord.date,
          status: ord.status,
          delivered: ord.delivered,
          reason: reasonFor(c),
        });
      }
      for (const o of (mine as any[]) || []) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        out.push({
          id: o.id,
          customer: o.customer || 'Customer',
          invoice_number: o.invoice_number,
          invoice_pdf_path: o.invoice_pdf_path,
          signed_pdf_path: o.signed_pdf_path,
          date: o.date,
          status: o.status,
          delivered: o.delivered,
          reason: 'You are the sales rep',
        });
      }
      out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      setRows(out);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openPdf(path: string | null, id: string) {
    if (!path) return;
    setBusy(id);
    const { data, error } = await supabase.storage.from('invoices').createSignedUrl(path, 300);
    setBusy(null);
    if (error || !data?.signedUrl) { alert('Could not open the file. ' + (error?.message || '')); return; }
    window.open(data.signedUrl, '_blank');
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">My Invoices</h1>
      <p className="text-sm text-gray-500 mb-4">Invoices you placed or that you&apos;re the salesman for. Tap to open the invoice or the signed copy.</p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400">No invoices yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{r.customer}</div>
                  <div className="text-xs text-gray-500">
                    {r.invoice_number ? `Invoice #${r.invoice_number}` : 'No invoice #'}
                    {r.date ? ` · ${r.date}` : ''} · {STATUS_LABEL[r.status] || r.status}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{r.reason}</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.invoice_pdf_path && (
                    <button onClick={() => openPdf(r.invoice_pdf_path, r.id)} disabled={busy === r.id}
                      className="px-3 py-1.5 text-xs rounded-md border border-brand-700 text-brand-700 hover:bg-gray-50 font-medium whitespace-nowrap disabled:opacity-50">
                      Invoice PDF
                    </button>
                  )}
                  {r.signed_pdf_path && (
                    <button onClick={() => openPdf(r.signed_pdf_path, r.id)} disabled={busy === r.id}
                      className="px-3 py-1.5 text-xs rounded-md border border-emerald-600 text-emerald-700 hover:bg-emerald-50 font-medium whitespace-nowrap disabled:opacity-50">
                      Signed copy
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
