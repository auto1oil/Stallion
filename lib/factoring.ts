// The factoring hand-off.
//
// A hauler can choose to have a ticket factored instead of waiting on
// Stallion's pay run. Once the office approves such a ticket, it is POSTed to
// the factoring service as "approved and ready to fund"; from there the
// factoring app runs the job and invoices Stallion itself.
//
// The connection is a webhook: an admin pastes the factoring app's endpoint
// (and an API key, if it wants one) under Work Orders → Setup. Until that's
// configured, factor-marked tickets simply record why they weren't sent, and
// every approval still succeeds — the hand-off must never block an approval,
// exactly like a failed QuickBooks call.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  billableQuantity, billableUnit, totalHours, totalLoadTons, countLoads,
  type WorkOrder, type WorkOrderLoad,
} from '@/lib/work-orders';
import { ensureTicketPdf } from '@/lib/ticket-pdf';

export const FACTORING_URL_KEY = 'factoring_webhook_url';
export const FACTORING_KEY_KEY = 'factoring_api_key';

export async function getFactoringConfig(
  db: SupabaseClient,
): Promise<{ url: string; apiKey: string } | null> {
  const { data } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', [FACTORING_URL_KEY, FACTORING_KEY_KEY]);
  const m = new Map(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
  const url = (m.get(FACTORING_URL_KEY) || '').trim();
  if (!url) return null;
  return { url, apiKey: (m.get(FACTORING_KEY_KEY) || '').trim() };
}

// One payload shape for both factoring calls — the approved-ticket webhook
// and the bill of sale render from the same fields.
async function buildTicketPayload(db: SupabaseClient, wo: WorkOrder) {
  const { data: loadRows } = await db
    .from('work_order_loads').select('*').eq('work_order_id', wo.id)
    .order('load_no');
  const loads = (loadRows as WorkOrderLoad[]) || [];

  let haulerName: string | null = null;
  if (wo.hauler_id) {
    const { data: h } = await db
      .from('haulers').select('name').eq('id', wo.hauler_id).maybeSingle();
    haulerName = (h as { name: string } | null)?.name ?? null;
  }

  // What the HAULER is owed — their own rate on their own quantity. The
  // customer side of the ticket is none of the factoring app's business.
  const qty = billableQuantity(wo, loads);
  const rate = Number(wo.rate || 0);
  const amount = Math.round(qty * rate * 100) / 100;

  return {
    loads,
    payload: {
      source: 'stallion-tank',
      ticket_id: wo.id,
      // Haulers are matched by this id on the factoring side (name is their
      // fallback), and it's what their 403 gate keys on.
      hauler_id: wo.hauler_id,
      // The supervisor/foreman's typed sign-off, displayed on the deal.
      supervisor_name: wo.foreman_signature_name,
      supervisor_signed_at: wo.foreman_signature_signed_at,
      ticket_number: wo.ticket_number,
      job_number: wo.job_number,
      job_name: wo.job_name,
      job_date: wo.job_date,
      phase_code: wo.phase_code,
      hauler: haulerName || wo.trucking_company,
      driver: wo.driver_name,
      unit_number: wo.unit_number,
      quantity: qty,
      unit: billableUnit(wo, loads),
      rate,
      amount,
      hours: totalHours(wo),
      loads: countLoads(loads),
      tons: totalLoadTons(loads),
    },
  };
}

async function postToFactoring(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---- The Auto 1 Funding account link ---------------------------------------
// Only a hauler with an approved account in the factoring app may Factor
// Payments. The link is requested from Stallion, approved by the factoring
// app's admin, and can be switched off over there at any time — so the truth
// lives there, Stallion caches the last answer on the haulers row, and the
// enforcement points ask live.

export type FactoringLinkStatus = 'none' | 'pending' | 'linked' | 'off';

// The factoring endpoints live side by side: .../tickets, .../bill-of-sale,
// .../link-request, .../link-status.
function siblingEndpoint(ticketsUrl: string, name: string): string | null {
  if (!/\/tickets\/?$/.test(ticketsUrl)) return null;
  return ticketsUrl.replace(/\/tickets\/?$/, `/${name}`);
}

// The factoring app says 'approved' where Stallion says 'linked' — accept
// either wording, plus their bare approved flag.
function normalizeLinkStatus(body: { status?: string; approved?: boolean } | null): FactoringLinkStatus | null {
  if (!body) return null;
  const s = body.status === 'approved' ? 'linked' : body.status;
  if (s && ['none', 'pending', 'linked', 'off'].includes(s)) return s as FactoringLinkStatus;
  if (body.approved === true) return 'linked';
  return null;
}

// Their tickets/bill-of-sale endpoints answer 403 with { status } when the
// hauler isn't approved. Turn that into words a person can act on.
function linkGateMessage(status: string | undefined): string {
  if (status === 'pending') return 'Auto 1 Funding hasn’t approved this company’s link yet';
  if (status === 'off') return 'this company’s Auto 1 Funding link is switched off';
  return 'this company’s Auto 1 Funding account isn’t linked';
}

async function cacheLinkStatus(db: SupabaseClient, haulerId: string, status: FactoringLinkStatus, requested = false) {
  const now = new Date().toISOString();
  await db.from('haulers').update({
    factoring_link_status: status,
    factoring_link_checked_at: now,
    ...(requested ? { factoring_link_requested_at: now } : {}),
  }).eq('id', haulerId);
}

// The hauler asks to link their Auto 1 Funding account; the request lands on
// the factoring app's admin queue.
export async function requestFactoringLink(
  db: SupabaseClient,
  haulerId: string,
): Promise<{ ok: boolean; status?: FactoringLinkStatus; error?: string }> {
  try {
    const { data: h } = await db.from('haulers').select('*').eq('id', haulerId).maybeSingle();
    if (!h) return { ok: false, error: 'company not found' };
    const config = await getFactoringConfig(db);
    if (!config) return { ok: false, error: 'the factoring app isn’t connected yet — ask Stallion' };
    const url = siblingEndpoint(config.url, 'link-request');
    if (!url) return { ok: false, error: 'the factoring endpoint URL should end in /tickets — ask Stallion to fix it' };

    const hauler = h as { name: string; mc_number: string | null; dot_number: string | null; contact_name: string | null; email: string | null; phone: string | null };
    const res = await postToFactoring(url, config.apiKey, {
      source: 'stallion-tank',
      hauler_id: haulerId,
      name: hauler.name,
      mc_number: hauler.mc_number,
      dot_number: hauler.dot_number,
      contact_name: hauler.contact_name,
      email: hauler.email,
      phone: hauler.phone,
    });
    if (!res.ok) return { ok: false, error: `factoring app answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; approved?: boolean } | null;
    if (!body?.ok) return { ok: false, error: 'the factoring app did not take the request' };
    const status = normalizeLinkStatus(body) || 'pending';
    await cacheLinkStatus(db, haulerId, status, true);
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'could not reach the factoring app' };
  }
}

// Ask the factoring app where the link stands right now. Falls back to the
// cached answer when they can't be reached, and says so.
export async function checkFactoringLink(
  db: SupabaseClient,
  haulerId: string,
): Promise<{ ok: boolean; status: FactoringLinkStatus; live: boolean; error?: string }> {
  const cached = async (): Promise<FactoringLinkStatus> => {
    const { data: h } = await db.from('haulers')
      .select('factoring_link_status').eq('id', haulerId).maybeSingle();
    const s = (h as { factoring_link_status: string | null } | null)?.factoring_link_status;
    return (['none', 'pending', 'linked', 'off'].includes(s || '') ? s : 'none') as FactoringLinkStatus;
  };
  try {
    const config = await getFactoringConfig(db);
    const url = config ? siblingEndpoint(config.url, 'link-status') : null;
    if (!config || !url) return { ok: true, status: await cached(), live: false, error: 'factoring app not connected' };

    const res = await postToFactoring(url, config.apiKey, {
      source: 'stallion-tank',
      hauler_id: haulerId,
    });
    if (!res.ok) return { ok: true, status: await cached(), live: false, error: `factoring app answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; approved?: boolean } | null;
    const status = body?.ok ? normalizeLinkStatus(body) : null;
    if (!status) {
      return { ok: true, status: await cached(), live: false, error: 'unreadable answer from the factoring app' };
    }
    await cacheLinkStatus(db, haulerId, status);
    return { ok: true, status, live: true };
  } catch (err) {
    return {
      ok: true, status: await cached(), live: false,
      error: err instanceof Error ? err.message : 'could not reach the factoring app',
    };
  }
}

export type BillOfSale = {
  ok: boolean;
  url?: string;
  accepted?: boolean;
  accepted_by?: string | null;
  accepted_at?: string | null;
  // 'unreachable' means the factoring app couldn't answer — callers decide
  // whether that blocks anything (completion doesn't wait on their uptime).
  error?: string;
  unreachable?: boolean;
};

// Ask the factoring app for this ticket's bill of sale. Idempotent per
// ticket: the same URL comes back with current acceptance state, and a
// re-POST after the ticket's numbers change refreshes the document.
export async function requestBillOfSale(
  db: SupabaseClient,
  workOrderId: string,
): Promise<BillOfSale> {
  try {
    const { data: row } = await db
      .from('work_orders').select('*').eq('id', workOrderId).maybeSingle();
    if (!row) return { ok: false, error: 'ticket not found' };
    const wo = row as WorkOrder;

    const config = await getFactoringConfig(db);
    if (!config) {
      return { ok: false, unreachable: true, error: 'factoring app not connected — set the endpoint under Work Orders → Setup' };
    }
    // The configured endpoint is the tickets webhook; the bill of sale lives
    // beside it. Refuse loudly if the URL doesn't follow that shape rather
    // than POSTing tickets at a guessed address.
    if (!/\/tickets\/?$/.test(config.url)) {
      return { ok: false, unreachable: true, error: 'the factoring endpoint URL should end in /tickets — fix it under Work Orders → Setup' };
    }
    const bosUrl = config.url.replace(/\/tickets\/?$/, '/bill-of-sale');

    const { payload } = await buildTicketPayload(db, wo);
    const res = await postToFactoring(bosUrl, config.apiKey, {
      ...payload,
      status: 'factor_payment_selected',
    });
    // 403 is their link gate — the hauler isn't approved (or was switched
    // off). Cache the answer so the Factor button disappears too.
    if (res.status === 403) {
      const gate = (await res.json().catch(() => null)) as { status?: string } | null;
      const s = normalizeLinkStatus(gate ? { status: gate.status } : null);
      if (s && wo.hauler_id) await cacheLinkStatus(db, wo.hauler_id, s);
      return { ok: false, error: linkGateMessage(gate?.status) };
    }
    if (!res.ok) {
      return { ok: false, unreachable: res.status >= 500, error: `factoring app answered ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as
      { ok?: boolean; url?: string; accepted?: boolean; accepted_by?: string | null; accepted_at?: string | null } | null;
    if (!body?.ok || !body.url) {
      return { ok: false, error: 'the factoring app did not return a bill of sale' };
    }
    return {
      ok: true,
      url: body.url,
      accepted: !!body.accepted,
      accepted_by: body.accepted_by ?? null,
      accepted_at: body.accepted_at ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      unreachable: true,
      error: err instanceof Error ? err.message : 'could not reach the factoring app',
    };
  }
}

// Send one approved, factor-marked ticket. Records the outcome on the row
// either way: factor_sent_at on success, factor_error on failure — an error
// with no sent-at is the retry queue.
export async function sendTicketToFactoring(
  db: SupabaseClient,
  workOrderId: string,
): Promise<{ ok: boolean; error?: string }> {
  const fail = async (reason: string) => {
    await db.from('work_orders')
      .update({ factor_error: reason })
      .eq('id', workOrderId);
    return { ok: false, error: reason };
  };

  try {
    const { data: row } = await db
      .from('work_orders').select('*').eq('id', workOrderId).maybeSingle();
    if (!row) return { ok: false, error: 'ticket not found' };
    const wo = row as WorkOrder;
    if (wo.payment_method !== 'factor') {
      return { ok: false, error: 'ticket is not marked for factoring' };
    }
    if (wo.factor_sent_at) return { ok: true };

    const config = await getFactoringConfig(db);
    if (!config) {
      return fail('factoring app not connected — set the endpoint under Work Orders → Setup');
    }

    // A fresh signed link to the ticket PDF. Generated here if invoicing
    // hasn't already done it (e.g. the office approved without invoicing). A
    // week gives their intake queue time without making the link permanent.
    let pdfPath = wo.ticket_pdf_path;
    if (!pdfPath) {
      const made = await ensureTicketPdf(db, wo.id);
      pdfPath = made?.path ?? null;
    }
    let pdfUrl: string | null = null;
    if (pdfPath) {
      const { data: signed } = await db.storage
        .from('work-tickets').createSignedUrl(pdfPath, 7 * 24 * 3600);
      pdfUrl = signed?.signedUrl ?? null;
    }

    const { payload } = await buildTicketPayload(db, wo);
    const res = await postToFactoring(config.url, config.apiKey, {
      ...payload,
      status: 'approved_ready_to_fund',
      approved_at: wo.office_approved_at,
      qb_invoice_number: wo.qb_invoice_number,
      ticket_pdf_url: pdfUrl,
    });
    // Their link gate: not approved (or switched off) over there. Recorded
    // like any other factor_error — the approval itself always stands.
    if (res.status === 403) {
      const gate = (await res.json().catch(() => null)) as { status?: string } | null;
      const s = normalizeLinkStatus(gate ? { status: gate.status } : null);
      if (s && wo.hauler_id) await cacheLinkStatus(db, wo.hauler_id, s);
      return fail(linkGateMessage(gate?.status));
    }
    if (!res.ok) {
      return fail(`factoring app answered ${res.status}`);
    }

    await db.from('work_orders')
      .update({ factor_sent_at: new Date().toISOString(), factor_error: null })
      .eq('id', workOrderId);
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'could not reach the factoring app');
  }
}
