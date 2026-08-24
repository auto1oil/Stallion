'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import TicketAttachment from '@/components/TicketAttachment';
import TicketSignature from '@/components/TicketSignature';
import {
  STATUS_LABEL, STATUS_TONE, onSiteHours, totalHours, ticketAmount,
  billableQuantity, billableUnit, type WorkOrder, type WorkOrderStatus,
} from '@/lib/work-orders';

// One of the contractor's crew tickets, read-only — except the short ticket,
// which the contractor is the one who has it and can attach here.

export default function ContractorTicketPage({ params }: { params: { id: string } }) {
  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.id]);

  async function load() {
    const res = await fetch(`/api/work-orders/${params.id}`, { cache: 'no-store' });
    const json = await res.json();
    if (!json.ok) { setError(json.error || 'Could not load this ticket.'); return; }
    setWo(json.work_order as WorkOrder);
  }

  async function saveShortTicket(path: string | null) {
    setBusy('upload'); setMsg('');
    const res = await fetch(`/api/work-orders/${params.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ short_ticket_path: path }),
    });
    const json = await res.json();
    setBusy('');
    if (!json.ok) { setMsg(json.error || 'Could not attach the short ticket.'); return; }
    setWo(json.work_order as WorkOrder);
    setMsg(path ? 'Short ticket attached.' : 'Short ticket removed.');
  }

  async function approve() {
    setBusy('approve'); setMsg('');
    const res = await fetch(`/api/work-orders/${params.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'contractor' }),
    });
    const json = await res.json();
    setBusy('');
    if (!json.ok) { setMsg(json.error || 'Could not record the approval.'); return; }
    setWo(json.work_order as WorkOrder);
    setMsg('Approved.');
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!wo) return <p className="text-sm text-gray-500">Loading…</p>;

  const facts: [string, string | null][] = [
    ['Customer #', wo.customer_number],
    ['Job #', wo.job_number],
    ['Day #', wo.day_number],
    ['Phase', wo.phase_code],
    ['Claim #', wo.claim_number],
    ['Unit #', wo.unit_number],
    ['FSR', wo.fsr],
    ['Date', wo.job_date],
    ['On site', `${onSiteHours(wo.start_at, wo.stop_at).toFixed(2)} hrs`],
    ['Travel', wo.travel_hours != null ? `${Number(wo.travel_hours).toFixed(2)} hrs` : null],
    ['Down time', wo.down_hours != null ? `${Number(wo.down_hours).toFixed(2)} hrs` : null],
    ['Total hours', `${totalHours(wo).toFixed(2)} hrs`],
    ['Tonnage', wo.tonnage != null ? `${Number(wo.tonnage).toFixed(2)} ${wo.tonnage_type || ''}`.trim() : null],
    ['Rate', wo.rate != null ? `$${Number(wo.rate).toFixed(2)}/${billableUnit(wo) === 'hrs' ? 'hr' : billableUnit(wo)}` : null],
    ['Bills', `${billableQuantity(wo).toFixed(2)} ${billableUnit(wo)} = $${ticketAmount(wo).toFixed(2)}`],
  ];

  return (
    <div>
      <Link href="/contractor" className="text-sm text-brand-700 hover:underline">← Work orders</Link>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mt-2 mb-3">
        <h1 className="text-2xl font-semibold">
          {wo.job_number ? `Job ${wo.job_number}` : 'Field ticket'}
          {wo.day_number ? ` · Day ${wo.day_number}` : ''}
        </h1>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_TONE[wo.status as WorkOrderStatus]}`}>
          {STATUS_LABEL[wo.status as WorkOrderStatus]}
        </span>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-3">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
          {facts.filter(([, v]) => v).map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {wo.notes && <p className="text-sm text-gray-600 mt-3 whitespace-pre-wrap">{wo.notes}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mb-3">
        <TicketAttachment label="Ticket photo" path={wo.ticket_photo_path} readOnly />
        <TicketAttachment
          label="Short ticket"
          hint="Attach the short ticket if you have it."
          path={wo.short_ticket_path}
          onChange={saveShortTicket}
          readOnly={busy === 'upload'}
        />
      </div>
      <div className="mb-3">
        <TicketSignature path={wo.signature_path} readOnly />
      </div>

      {msg && <p className="text-sm text-gray-700 mb-2">{msg}</p>}

      {wo.contractor_approved_at ? (
        <p className="text-sm text-emerald-700">
          You approved this on {new Date(wo.contractor_approved_at).toLocaleString()}.
        </p>
      ) : (
        <button
          onClick={approve}
          disabled={!!busy || wo.status === 'draft' || wo.status === 'rejected'}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 font-medium"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve this ticket'}
        </button>
      )}
    </div>
  );
}
