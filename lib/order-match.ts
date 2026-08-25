// Server-side reconciliation of a ticket against the order it was filed on.
//
// This runs on every ticket save. It lives on the server for the same reason
// the money does: a flag the browser could set is a flag the browser could
// clear, and the whole point is that a ticket disagreeing with its order can't
// slip through unnoticed.
//
// Clearing a flag is a person's decision — the office looking at it and saying
// it's fine — so it is never cleared here. Re-saving a ticket recomputes the
// flag from scratch, and if the disagreement is still there it comes back.

import type { SupabaseClient } from '@supabase/supabase-js';
import { findMismatch, type JobOrder } from '@/lib/job-orders';
import type { WorkOrder } from '@/lib/work-orders';

// Work out the order_mismatch value for a ticket that is about to be written.
// `patch` is the incoming change; `existing` is what's already stored, so a
// partial update still gets compared on the ticket's full values.
export async function computeOrderMismatch(
  db: SupabaseClient,
  patch: Record<string, unknown>,
  existing: Partial<WorkOrder> | null,
): Promise<string | null> {
  const orderId = ('order_id' in patch ? patch.order_id : existing?.order_id) as string | null;
  if (!orderId) return null;

  const { data } = await db
    .from('job_orders')
    .select('rate, pay_rate, phase_code, job_number, start_date, end_date')
    .eq('id', orderId)
    .maybeSingle();
  if (!data) return null;

  const merged = { ...(existing || {}), ...patch } as Pick<
    WorkOrder, 'rate' | 'phase_code' | 'job_number' | 'job_date'
  > & { hauler_id?: string | null };
  return findMismatch(merged, data as Pick<
    JobOrder, 'rate' | 'pay_rate' | 'phase_code' | 'job_number' | 'start_date' | 'end_date'
  >);
}

// Apply the flag to a patch about to be written. Whenever the flag changes,
// any previous "the office looked at this and it's fine" is dropped — an
// all-clear given on a different set of numbers means nothing.
export async function withOrderMismatch(
  db: SupabaseClient,
  patch: Record<string, unknown>,
  existing: Partial<WorkOrder> | null,
): Promise<Record<string, unknown>> {
  const mismatch = await computeOrderMismatch(db, patch, existing);
  if (mismatch === (existing?.order_mismatch ?? null)) return patch;
  return {
    ...patch,
    order_mismatch: mismatch,
    mismatch_cleared_by: null,
    mismatch_cleared_at: null,
  };
}
