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

    const { data: loadRows } = await db
      .from('work_order_loads').select('*').eq('work_order_id', workOrderId)
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

    const payload = {
      source: 'stallion-tank',
      status: 'approved_ready_to_fund',
      ticket_id: wo.id,
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
      approved_at: wo.office_approved_at,
      qb_invoice_number: wo.qb_invoice_number,
      ticket_pdf_url: pdfUrl,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
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
