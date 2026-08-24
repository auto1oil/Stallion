'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import TicketAttachment from '@/components/TicketAttachment';
import TicketSignature from '@/components/TicketSignature';
import {
  onSiteHours, totalHours, ticketAmount, billableUnit,
  type WorkOrder,
} from '@/lib/work-orders';

// The field ticket itself — one form used three ways: a crew member filling one
// out, the same crew member fixing a draft, and the office editing a submitted
// ticket before approving it. `canApprove` puts the office's Approve / Send back
// buttons at the bottom.

type Customer = { id: string; name: string; business_id: string | null; profile_id: string | null };
type Rate = { job_number: string; phase_code: string | null; rate: number; rate_unit: string; description: string | null };

// Local editing state: every field is a string so an emptied input stays empty
// instead of snapping back to 0.
type Draft = Record<string, string>;

const TONNAGE_TYPES = ['', 'Dirt', 'Gravel', 'Asphalt', 'Debris', 'Water', 'Other'];

function toDraft(wo: Partial<WorkOrder> | null): Draft {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  return {
    customer_id: v(wo?.customer_id),
    customer_number: v(wo?.customer_number),
    job_number: v(wo?.job_number),
    day_number: v(wo?.day_number),
    phase_code: v(wo?.phase_code),
    claim_number: v(wo?.claim_number),
    unit_number: v(wo?.unit_number),
    fsr: v(wo?.fsr),
    job_date: v(wo?.job_date) || new Date().toISOString().slice(0, 10),
    start_at: toLocalInput(wo?.start_at ?? null),
    stop_at: toLocalInput(wo?.stop_at ?? null),
    travel_hours: v(wo?.travel_hours),
    down_hours: v(wo?.down_hours),
    rate: v(wo?.rate),
    tonnage: v(wo?.tonnage),
    tonnage_type: v(wo?.tonnage_type),
    notes: v(wo?.notes),
  };
}

// <input type="datetime-local"> speaks local wall-clock time; the column stores
// an absolute instant. Convert both ways so a saved ticket reopens showing the
// same times the crew typed.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function WorkOrderForm({
  workOrder,
  canApprove = false,
  onSaved,
}: {
  workOrder: WorkOrder | null;
  canApprove?: boolean;
  onSaved?: (wo: WorkOrder) => void;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(workOrder));
  const [ticketPhoto, setTicketPhoto] = useState<string | null>(workOrder?.ticket_photo_path ?? null);
  const [shortTicket, setShortTicket] = useState<string | null>(workOrder?.short_ticket_path ?? null);
  const [signature, setSignature] = useState<string | null>(workOrder?.signature_path ?? null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const id = workOrder?.id ?? null;
  const status = workOrder?.status ?? 'draft';
  // A draft or a sent-back ticket is the crew's to edit; once the office has
  // it, only the office can change it.
  const editable = status === 'draft' || status === 'rejected' || status === 'submitted';
  // An invoiced ticket is closed to everyone — the money is booked in
  // QuickBooks, so a change here would silently disagree with the invoice.
  const locked = status === 'invoiced' || (!editable && !canApprove);

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    (async () => {
      const [{ data: bizRows }, { data: rateRows }] = await Promise.all([
        supabase.from('businesses').select('id, name').order('name'),
        supabase.from('job_rates').select('job_number, phase_code, rate, rate_unit, description').eq('active', true),
      ]);
      setCustomers(((bizRows as { id: string; name: string }[]) || [])
        .map((b) => ({ id: b.id, name: b.name, business_id: b.id, profile_id: null })));
      setRates((rateRows as Rate[]) || []);
    })();
  }, [supabase]);

  // The agreed rate for the job/phase typed above, so the crew doesn't have to
  // remember it. Exact phase match wins; a job-wide rate is the fallback.
  const suggestedRate = useMemo(() => {
    const job = draft.job_number.trim();
    if (!job) return null;
    const forJob = rates.filter((r) => r.job_number === job);
    if (forJob.length === 0) return null;
    const phase = draft.phase_code.trim();
    return forJob.find((r) => (r.phase_code || '') === phase) || forJob.find((r) => !r.phase_code) || forJob[0];
  }, [rates, draft.job_number, draft.phase_code]);

  const preview = {
    start_at: fromLocalInput(draft.start_at),
    stop_at: fromLocalInput(draft.stop_at),
    travel_hours: Number(draft.travel_hours) || 0,
    down_hours: Number(draft.down_hours) || 0,
    rate: Number(draft.rate) || 0,
    tonnage: Number(draft.tonnage) || 0,
    tonnage_type: draft.tonnage_type || null,
  };
  const hours = totalHours(preview);
  const amount = ticketAmount(preview);

  function body(): Record<string, unknown> {
    return {
      business_id: draft.customer_id || null,
      customer_number: draft.customer_number.trim() || null,
      job_number: draft.job_number.trim() || null,
      day_number: draft.day_number.trim() || null,
      phase_code: draft.phase_code.trim() || null,
      claim_number: draft.claim_number.trim() || null,
      unit_number: draft.unit_number.trim() || null,
      fsr: draft.fsr.trim() || null,
      job_date: draft.job_date || null,
      start_at: fromLocalInput(draft.start_at),
      stop_at: fromLocalInput(draft.stop_at),
      travel_hours: draft.travel_hours === '' ? null : Number(draft.travel_hours),
      down_hours: draft.down_hours === '' ? null : Number(draft.down_hours),
      rate: draft.rate === '' ? null : Number(draft.rate),
      tonnage: draft.tonnage === '' ? null : Number(draft.tonnage),
      tonnage_type: draft.tonnage_type || null,
      ticket_photo_path: ticketPhoto,
      short_ticket_path: shortTicket,
      signature_path: signature,
      notes: draft.notes.trim() || null,
    };
  }

  async function save(submit: boolean) {
    if (submit) {
      if (!draft.job_number.trim()) { setError('Enter the job number before submitting.'); return; }
      if (!draft.start_at || !draft.stop_at) { setError('Enter the start and stop times before submitting.'); return; }
      if (!ticketPhoto) { setError('Attach a photo of the paper ticket before submitting.'); return; }
    }
    setBusy(submit ? 'submit' : 'save'); setError(''); setMsg('');
    try {
      const res = await fetch(id ? `/api/work-orders/${id}` : '/api/work-orders', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body(), submit }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not save the ticket.'); return; }
      setMsg(submit ? 'Submitted to the office.' : 'Saved.');
      onSaved?.(json.work_order as WorkOrder);
      if (!id) router.replace(`/tickets/${json.work_order.id}`);
      else router.refresh();
    } catch {
      setError('Network error — check your signal and try again.');
    } finally {
      setBusy('');
    }
  }

  async function approve(reject: boolean) {
    if (!id) return;
    const reason = reject ? window.prompt('What needs fixing?')?.trim() : '';
    if (reject && !reason) return;
    setBusy(reject ? 'reject' : 'approve'); setError(''); setMsg('');
    try {
      // Save any edits first so the office approves what's on screen.
      await fetch(`/api/work-orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const res = await fetch(`/api/work-orders/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as: 'office', reject, reason }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not record the approval.'); return; }
      if (json.invoice_error) setMsg(`Approved, but QuickBooks said: ${json.invoice_error}. Retry the invoice from the list.`);
      else if (json.invoice) setMsg(`Approved and invoiced — QuickBooks #${json.invoice.invoice_number}.`);
      else setMsg(reject ? 'Sent back to the crew.' : 'Approved.');
      onSaved?.(json.work_order as WorkOrder);
      router.refresh();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy('');
    }
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Job</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="col-span-2 sm:col-span-3">
            <span className={label}>Customer</span>
            <select value={draft.customer_id} onChange={(e) => set('customer_id', e.target.value)} disabled={locked} className={input}>
              <option value="">— Pick a customer —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label><span className={label}>Customer #</span>
            <input value={draft.customer_number} onChange={(e) => set('customer_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Job #</span>
            <input value={draft.job_number} onChange={(e) => set('job_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Day #</span>
            <input value={draft.day_number} onChange={(e) => set('day_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Phase code</span>
            <input value={draft.phase_code} onChange={(e) => set('phase_code', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Claim #</span>
            <input value={draft.claim_number} onChange={(e) => set('claim_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Unit # (truck)</span>
            <input value={draft.unit_number} onChange={(e) => set('unit_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>FSR</span>
            <input value={draft.fsr} onChange={(e) => set('fsr', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Date</span>
            <input type="date" value={draft.job_date} onChange={(e) => set('job_date', e.target.value)} disabled={locked} className={input} />
          </label>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Time &amp; amounts</h2>
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>Start</span>
            <input type="datetime-local" value={draft.start_at} onChange={(e) => set('start_at', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Stop</span>
            <input type="datetime-local" value={draft.stop_at} onChange={(e) => set('stop_at', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Travel hours</span>
            <input type="number" step="0.25" min="0" inputMode="decimal" value={draft.travel_hours} onChange={(e) => set('travel_hours', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Down time (hrs)</span>
            <input type="number" step="0.25" min="0" inputMode="decimal" value={draft.down_hours} onChange={(e) => set('down_hours', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Tonnage</span>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={draft.tonnage} onChange={(e) => set('tonnage', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Tonnage type</span>
            <select value={draft.tonnage_type} onChange={(e) => set('tonnage_type', e.target.value)} disabled={locked} className={input}>
              {TONNAGE_TYPES.map((t) => <option key={t} value={t}>{t || '— None —'}</option>)}
            </select>
          </label>
          <label className="col-span-2"><span className={label}>Rate ($ per {billableUnit(preview) === 'hrs' ? 'hour' : billableUnit(preview)})</span>
            <input type="number" step="0.01" min="0" inputMode="decimal" value={draft.rate} onChange={(e) => set('rate', e.target.value)} disabled={locked} className={input} />
            {suggestedRate && Number(draft.rate) !== Number(suggestedRate.rate) && (
              <button
                type="button"
                onClick={() => set('rate', String(suggestedRate.rate))}
                className="mt-1 text-[11px] text-brand-700 hover:underline"
              >
                Use the agreed rate for job {suggestedRate.job_number}: ${Number(suggestedRate.rate).toFixed(2)}/{suggestedRate.rate_unit}
              </button>
            )}
          </label>
        </div>

        <div className="mt-3 rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
          <span className="text-gray-600">On site <strong className="tabular-nums">{onSiteHours(preview.start_at, preview.stop_at).toFixed(2)}</strong> hrs</span>
          <span className="text-gray-600">Total <strong className="tabular-nums">{hours.toFixed(2)}</strong> hrs</span>
          <span className="text-gray-900 font-medium">Bills <span className="tabular-nums">${amount.toFixed(2)}</span></span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TicketAttachment
          label="Ticket photo"
          hint="The paper ticket — take the picture here."
          path={ticketPhoto}
          onChange={setTicketPhoto}
          readOnly={locked}
        />
        <TicketAttachment
          label="Short ticket"
          hint="The short ticket, if there is one."
          path={shortTicket}
          onChange={setShortTicket}
          readOnly={locked}
        />
      </div>

      <TicketSignature path={signature} onChange={setSignature} readOnly={locked} />

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <label><span className={label}>Notes</span>
          <textarea rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} disabled={locked} className={input} />
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-emerald-700">{msg}</p>}

      <div className="flex flex-wrap gap-2 pb-8">
        {!locked && (
          <>
            <button
              onClick={() => save(false)}
              disabled={!!busy}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            {(status === 'draft' || status === 'rejected') && (
              <button
                onClick={() => save(true)}
                disabled={!!busy}
                className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
              >
                {busy === 'submit' ? 'Submitting…' : status === 'rejected' ? 'Fix and resubmit' : 'Submit ticket'}
              </button>
            )}
          </>
        )}
        {canApprove && status === 'submitted' && (
          <>
            <button
              onClick={() => approve(false)}
              disabled={!!busy}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 font-medium"
            >
              {busy === 'approve' ? 'Approving…' : 'Approve & invoice'}
            </button>
            <button
              onClick={() => approve(true)}
              disabled={!!busy}
              className="px-4 py-2 text-sm border border-red-300 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50"
            >
              {busy === 'reject' ? 'Sending back…' : 'Send back'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
