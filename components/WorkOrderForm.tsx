'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import TicketAttachment from '@/components/TicketAttachment';
import TicketSignature from '@/components/TicketSignature';
import LoadLines from '@/components/LoadLines';
import CustomerPicker from '@/components/CustomerPicker';
import HaulerOnTicket from '@/components/HaulerOnTicket';
import { orderLabel, ticketDefaultsFrom, type JobOrder } from '@/lib/job-orders';
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
// The 'Truck Type — check one' box on the paper ticket, in the printed order.
// StrongArm and End Dump carry a tonnage on the form, which is why there's a
// separate tons field beside the picker.
const TRUCK_TYPES = [
  'Truck & Pup', 'Double Belly', '6 Axel SS or DS',
  'StrongArm', 'Single Belly', 'Super Side',
  'End Dump', 'Vacuum Trailer', 'Single Side',
];
const TRUCK_TYPES_WITH_TONS = ['StrongArm', 'End Dump'];
// Suggestions only — the field is free text, so a unit that isn't listed
// still gets typed in rather than being blocked.
const EQUIPMENT_TYPES = [
  'Belly Dump', 'End Dump', 'Side Dump', 'Side Dump Double', 'Super Dump',
  'Water Truck', 'Lowboy', 'Excavator', 'Loader', 'Dozer', 'Blade', 'Skid Steer',
];

function toDraft(wo: Partial<WorkOrder> | null): Draft {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  return {
    order_id: v(wo?.order_id),
    customer_id: v(wo?.customer_id),
    customer_number: v(wo?.customer_number),
    job_number: v(wo?.job_number),
    job_name: v(wo?.job_name),
    job_address: v(wo?.job_address),
    driver_name: v(wo?.driver_name),
    ticket_number: v(wo?.ticket_number),
    trucking_company: v(wo?.trucking_company),
    material: v(wo?.material),
    supplier: v(wo?.supplier),
    truck_type: v(wo?.truck_type),
    truck_type_tons: v(wo?.truck_type_tons),
    driver_start_at: toLocalInput(wo?.driver_start_at ?? null),
    driver_end_at: toLocalInput(wo?.driver_end_at ?? null),
    signed_out_state: v(wo?.signed_out_state),
    sign_out_at: toLocalInput(wo?.sign_out_at ?? null),
    day_number: v(wo?.day_number),
    phase_code: v(wo?.phase_code),
    claim_number: v(wo?.claim_number),
    unit_number: v(wo?.unit_number),
    equipment_type: v(wo?.equipment_type),
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
  const [foremanSignature, setForemanSignature] = useState<string | null>(workOrder?.foreman_signature_path ?? null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [orders, setOrders] = useState<JobOrder[]>([]);
  // A hauler filling their own ticket is owed the order's pay rate; the
  // customer rate lives on the order, which haulers cannot read at all.
  const [isHauler, setIsHauler] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  // Rolled up from the load lines so the live total matches what the server
  // will bill — it recomputes from the same rows before invoicing.
  const [loadTotals, setLoadTotals] = useState<{ loads: number; tons: number }>({ loads: 0, tons: 0 });

  const id = workOrder?.id ?? null;
  const status = workOrder?.status ?? 'draft';
  // A draft or a sent-back ticket is the crew's to edit; once the office has
  // it, only the office can change it.
  const editable = status === 'draft' || status === 'rejected' || status === 'submitted';
  // An invoiced ticket is closed to everyone — the money is booked in
  // QuickBooks, so a change here would silently disagree with the invoice.
  const locked = status === 'invoiced' || (!editable && !canApprove);

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  // Picking an order pulls its agreed terms onto the ticket. Only blank
  // fields are filled — a crew that already typed a rate keeps it, and the
  // difference is what gets flagged for the office rather than overwritten.
  function applyOrder(orderId: string) {
    const picked = orders.find((o) => o.id === orderId);
    if (!picked) { set('order_id', orderId); return; }
    const defaults = ticketDefaultsFrom(picked, isHauler);
    setDraft((d) => {
      const next = { ...d, order_id: orderId };
      for (const [k, val] of Object.entries(defaults)) {
        if (!next[k]) next[k] = val;
      }
      return next;
    });
  }

  useEffect(() => {
    (async () => {
      const [{ data: bizRows }, { data: rateRows }, { data: orderRows }] = await Promise.all([
        supabase.from('businesses').select('id, name').order('name'),
        supabase.from('job_rates').select('job_number, phase_code, rate, rate_unit, description').eq('active', true),
        // Finished and cancelled orders aren't offered — a ticket filed
        // against one is almost always the wrong order picked in a hurry.
        supabase.from('job_orders').select('*').in('status', ['open', 'active'])
          .order('order_number', { ascending: false }),
      ]);
      setCustomers(((bizRows as { id: string; name: string }[]) || [])
        .map((b) => ({ id: b.id, name: b.name, business_id: b.id, profile_id: null })));
      setRates((rateRows as Rate[]) || []);
      setOrders((orderRows as JobOrder[]) || []);
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        setIsHauler(me?.role === 'hauler');
      }
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
  // Bill off the load lines when they carry weights, exactly as the server
  // does at invoice time, so the figure on screen is the figure billed.
  const previewLoads = [{ tons: loadTotals.tons }];
  const amount = ticketAmount(preview, previewLoads);
  const unit = billableUnit(preview, previewLoads);

  function body(): Record<string, unknown> {
    return {
      order_id: draft.order_id || null,
      business_id: draft.customer_id || null,
      customer_number: draft.customer_number.trim() || null,
      job_number: draft.job_number.trim() || null,
      job_name: draft.job_name.trim() || null,
      job_address: draft.job_address.trim() || null,
      driver_name: draft.driver_name.trim() || null,
      ticket_number: draft.ticket_number.trim() || null,
      trucking_company: draft.trucking_company.trim() || null,
      material: draft.material.trim() || null,
      supplier: draft.supplier.trim() || null,
      truck_type: draft.truck_type || null,
      truck_type_tons: draft.truck_type_tons === '' ? null : Number(draft.truck_type_tons),
      driver_start_at: fromLocalInput(draft.driver_start_at),
      driver_end_at: fromLocalInput(draft.driver_end_at),
      signed_out_state: draft.signed_out_state || null,
      sign_out_at: fromLocalInput(draft.sign_out_at),
      day_number: draft.day_number.trim() || null,
      phase_code: draft.phase_code.trim() || null,
      claim_number: draft.claim_number.trim() || null,
      unit_number: draft.unit_number.trim() || null,
      equipment_type: draft.equipment_type.trim() || null,
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
      foreman_signature_path: foremanSignature,
      notes: draft.notes.trim() || null,
    };
  }

  async function save(submit: boolean) {
    if (submit) {
      if (!draft.job_number.trim()) { setError('Enter the job number before completing the ticket.'); return; }
      if (!draft.start_at || !draft.stop_at) { setError('Enter the start and stop times before completing the ticket.'); return; }
      if (!ticketPhoto) { setError('Attach a photo of the paper ticket before completing it.'); return; }
      if (!foremanSignature) { setError('The job foreman needs to sign the ticket before it goes in.'); return; }
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
      setMsg(submit ? 'Completed — it\u2019s with the office now.' : 'Saved.');
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
      {workOrder?.hauler_id && <HaulerOnTicket haulerId={workOrder.hauler_id} />}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Job</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {/* The order book and the customer directory are Stallion's — a
              hauling company cannot read either, by design, because the order
              carries the customer rate. So rather than show them two pickers
              that can never fill, their ticket says where its job comes from. */}
          {isHauler ? (
            <div className="col-span-2 sm:col-span-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
              {draft.order_id ? (
                <span className="text-gray-700">
                  This ticket is against the job Stallion sent you. The details below came
                  with it — correct anything that ran differently on the day.
                </span>
              ) : (
                <span className="text-gray-700">
                  Start a ticket from the load Stallion sent you and the job fills itself in.
                  Open{' '}
                  <Link href="/hauler" className="text-brand-700 font-medium hover:underline">Loads</Link>
                  {' '}and use the ticket on the one you accepted. Filling this in by hand works
                  too — the office will just have to check it against the job themselves.
                </span>
              )}
            </div>
          ) : (
            <>
              <label className="col-span-2 sm:col-span-3">
                <span className={label}>Order</span>
                <select value={draft.order_id} onChange={(e) => applyOrder(e.target.value)} disabled={locked} className={input}>
                  <option value="">— No order —</option>
                  {orders.map((o) => <option key={o.id} value={o.id}>{orderLabel(o)}</option>)}
                </select>
                <span className="block mt-1 text-[11px] text-gray-500">
                  {draft.order_id
                    ? 'This ticket is billed against that order. Anything that disagrees with it gets flagged for the office.'
                    : orders.length === 0
                      ? 'No open orders yet — create one under Orders first.'
                      : 'Pick the job this ticket is for and the rest fills in.'}
                </span>
              </label>
              <div className="col-span-2 sm:col-span-3">
                <CustomerPicker value={draft.customer_id} onChange={(id) => set('customer_id', id)} disabled={locked} />
              </div>
            </>
          )}
          <label><span className={label}>Driver name</span>
            <input value={draft.driver_name} onChange={(e) => set('driver_name', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Ticket #</span>
            <input value={draft.ticket_number} onChange={(e) => set('ticket_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Trucking company</span>
            <input value={draft.trucking_company} onChange={(e) => set('trucking_company', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Customer #</span>
            <input value={draft.customer_number} onChange={(e) => set('customer_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Job #</span>
            <input value={draft.job_number} onChange={(e) => set('job_number', e.target.value)} disabled={locked} className={input} />
          </label>
          <label className="col-span-2"><span className={label}>Job name</span>
            <input value={draft.job_name} onChange={(e) => set('job_name', e.target.value)} disabled={locked} className={input} />
          </label>
          <label className="col-span-2 sm:col-span-3"><span className={label}>Job address</span>
            <input value={draft.job_address} onChange={(e) => set('job_address', e.target.value)} disabled={locked} className={input} />
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
          <label><span className={label}>Equipment type</span>
            <input value={draft.equipment_type} onChange={(e) => set('equipment_type', e.target.value)} disabled={locked} className={input} list="equipment-types" />
            <datalist id="equipment-types">
              {EQUIPMENT_TYPES.map((t) => <option key={t} value={t} />)}
            </datalist>
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Material &amp; truck</h2>
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>Material</span>
            <input value={draft.material} onChange={(e) => set('material', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Supplier</span>
            <input value={draft.supplier} onChange={(e) => set('supplier', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Truck type</span>
            <select value={draft.truck_type} onChange={(e) => set('truck_type', e.target.value)} disabled={locked} className={input}>
              <option value="">— Pick one —</option>
              {TRUCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              <option value="Other">Other</option>
            </select>
          </label>
          {/* StrongArm and End Dump are written with a tonnage on the paper. */}
          {TRUCK_TYPES_WITH_TONS.includes(draft.truck_type) && (
            <label><span className={label}>{draft.truck_type} tons</span>
              <input type="number" step="0.01" min="0" inputMode="decimal" value={draft.truck_type_tons}
                onChange={(e) => set('truck_type_tons', e.target.value)} disabled={locked} className={input} />
            </label>
          )}
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
          <label><span className={label}>Driver time start</span>
            <input type="datetime-local" value={draft.driver_start_at} onChange={(e) => set('driver_start_at', e.target.value)} disabled={locked} className={input} />
          </label>
          <label><span className={label}>Driver time end</span>
            <input type="datetime-local" value={draft.driver_end_at} onChange={(e) => set('driver_end_at', e.target.value)} disabled={locked} className={input} />
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
          <label className="col-span-2"><span className={label}>Rate ($ per {unit === 'hrs' ? 'hour' : unit})</span>
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
          {loadTotals.loads > 0 && (
            <span className="text-gray-600">
              <strong className="tabular-nums">{loadTotals.loads}</strong> loads ·{' '}
              <strong className="tabular-nums">{loadTotals.tons.toFixed(2)}</strong> tons
            </span>
          )}
          <span className="text-gray-900 font-medium">Bills <span className="tabular-nums">${amount.toFixed(2)}</span></span>
        </div>
      </div>

      {/* The sixteen load lines. They hang off the saved ticket, so on a brand
          new one they appear as soon as it's been saved once as a draft. */}
      {id ? (
        <LoadLines
          workOrderId={id}
          locked={locked}
          onTotalsChange={setLoadTotals}
        />
      ) : (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-4 text-sm text-gray-600">
          <strong className="block text-gray-900 mb-1">Loads</strong>
          Save this ticket as a draft and the sixteen load lines open up, with
          one-tap in and out times for each load.
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">Signed out</h2>
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>Loaded or empty</span>
            <select value={draft.signed_out_state} onChange={(e) => set('signed_out_state', e.target.value)} disabled={locked} className={input}>
              <option value="">—</option>
              <option value="loaded">Loaded</option>
              <option value="empty">Empty</option>
            </select>
          </label>
          <label><span className={label}>Sign out time</span>
            <input type="datetime-local" value={draft.sign_out_at} onChange={(e) => set('sign_out_at', e.target.value)} disabled={locked} className={input} />
          </label>
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

      <div className="grid gap-3 sm:grid-cols-2">
        <TicketSignature
          path={signature}
          onChange={setSignature}
          readOnly={locked}
          label="Driver's signature"
        />
        <TicketSignature
          path={foremanSignature}
          onChange={setForemanSignature}
          readOnly={locked}
          label="Foreman's signature"
          hint="Signed off on site at the end of the day."
        />
      </div>

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
                {busy === 'submit' ? 'Completing…' : status === 'rejected' ? 'Fix and send back' : 'Complete ticket'}
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
