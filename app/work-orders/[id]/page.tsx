'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { STATUS_LABEL, STATUS_TONE, type WorkOrder, type WorkOrderStatus } from '@/lib/work-orders';
import WorkOrderForm from '@/components/WorkOrderForm';

// The office's view of one ticket: the same form the crew filled in, fully
// editable, with Approve / Send back at the bottom and the approval trail on
// the side.

type Person = { id: string; full_name: string | null; email: string };

export default function OfficeWorkOrderPage({ params }: { params: { id: string } }) {
  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [people, setPeople] = useState<Record<string, Person>>({});
  const [error, setError] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceMsg, setInvoiceMsg] = useState('');

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/work-orders/${params.id}`, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not load this ticket.'); return; }
      setWo(json.work_order as WorkOrder);
    })();
  }, [params.id]);

  // Resolve the ids on the approval trail to names (every signed-in user may
  // read profiles, so this is a direct query).
  useEffect(() => {
    if (!wo) return;
    const ids = Array.from(new Set(
      [wo.submitted_by, wo.office_approved_by, wo.contractor_approved_by, wo.funder_approved_by]
        .filter((v): v is string => !!v),
    ));
    if (ids.length === 0) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', ids);
      setPeople(Object.fromEntries(((data as Person[]) || []).map((p) => [p.id, p])));
    })();
  }, [wo]);

  async function invoiceNow() {
    if (!wo) return;
    setInvoiceBusy(true); setInvoiceMsg('');
    const res = await fetch(`/api/work-orders/${wo.id}/invoice`, { method: 'POST' });
    const json = await res.json();
    setInvoiceBusy(false);
    setInvoiceMsg(json.ok ? `Invoiced — QuickBooks #${json.invoice_number}.` : (json.error || 'QuickBooks invoice failed.'));
    if (json.ok) {
      const fresh = await fetch(`/api/work-orders/${wo.id}`, { cache: 'no-store' }).then((r) => r.json());
      if (fresh.ok) setWo(fresh.work_order as WorkOrder);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!wo) return <p className="text-sm text-gray-500">Loading…</p>;

  const name = (id: string | null) => (id ? (people[id]?.full_name || people[id]?.email || 'Staff') : null);
  const trail = [
    { label: 'Submitted', who: name(wo.submitted_by), at: wo.submitted_at },
    { label: 'Office', who: name(wo.office_approved_by), at: wo.office_approved_at },
    { label: 'Contractor', who: name(wo.contractor_approved_by), at: wo.contractor_approved_at },
    { label: 'Funds', who: name(wo.funder_approved_by), at: wo.funder_approved_at },
  ].filter((t) => t.at);

  return (
    <div>
      <Link href="/work-orders/approve" className="text-sm text-brand-700 hover:underline">← Review queue</Link>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mt-2 mb-3">
        <h1 className="text-2xl font-semibold">
          {wo.job_number ? `Job ${wo.job_number}` : 'Field ticket'}
          {wo.day_number ? ` · Day ${wo.day_number}` : ''}
        </h1>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_TONE[wo.status as WorkOrderStatus]}`}>
          {STATUS_LABEL[wo.status as WorkOrderStatus]}
        </span>
      </div>

      {trail.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 mb-3 text-xs text-gray-600 flex flex-wrap gap-x-5 gap-y-1">
          {trail.map((t) => (
            <span key={t.label}>
              <span className="font-medium text-gray-700">{t.label}:</span>{' '}
              {t.who ? `${t.who} · ` : ''}{new Date(t.at as string).toLocaleString()}
            </span>
          ))}
        </div>
      )}

      {(wo.status === 'office_approved' || wo.status === 'funds_approved') && !wo.qb_invoice_id && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-amber-900">Approved but not invoiced yet.</span>
          <button
            onClick={invoiceNow}
            disabled={invoiceBusy}
            className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
          >
            {invoiceBusy ? 'Invoicing…' : 'Invoice in QuickBooks'}
          </button>
        </div>
      )}
      {wo.qb_invoice_number && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 mb-3">
          Invoiced in QuickBooks as #{wo.qb_invoice_number}.
        </p>
      )}
      {invoiceMsg && <p className="text-sm text-gray-700 mb-3">{invoiceMsg}</p>}

      <WorkOrderForm workOrder={wo} canApprove onSaved={setWo} />
    </div>
  );
}
