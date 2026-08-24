// /api/quickbooks/edit-invoice — admin-only invoice corrections.
//
// GET  ?order_id=<orders.id>   → returns the linked QB invoice's editable
//                                sales-item lines (id, name, qty, unit price).
// POST { order_id, edits }     → applies qty/unitPrice edits to those lines in
//                                QuickBooks (edits the existing invoice in
//                                place), re-downloads the corrected PDF, stores
//                                it, and updates the order. edits is keyed by QB
//                                line Id → { qty?, unitPrice? }.
//
// Works on dispatch `orders` rows that already have a QB invoice_number
// (Out-for-delivery + Delivered). QB stays the source of truth: we pull the
// live invoice, edit its lines, push it back with the right SyncToken.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import {
  getInvoiceByDocNumber, getInvoiceById, updateInvoiceLines, rebuildInvoiceLines,
  fetchInvoicePdf, listAllItems,
  type QBFullInvoice, type DesiredLine,
} from '@/lib/quickbooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Rebuilding lines + re-fetching the PDF is several
// QuickBooks round-trips; without a raised limit the request times out and the
// dropped connection surfaces as "Network error saving the invoice".
export const maxDuration = 60;

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, error: 'not signed in', status: 401 as const, actorName: '' };
  const { data: actor } = await supabase.from('profiles').select('role, full_name, email').eq('id', user.id).single();
  if (!actor || (actor.role !== 'admin' && actor.role !== 'master_admin')) {
    return { supabase, error: 'admin required', status: 403 as const, actorName: '' };
  }
  return { supabase, error: null, status: 200 as const, actorName: (actor.full_name || actor.email || 'Admin') as string };
}

// Pull the order's invoice number, then the live QB invoice.
async function loadInvoiceForOrder(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
): Promise<{ invoice: QBFullInvoice | null; invoiceNumber: string | null; error?: string }> {
  const { data: order } = await supabase
    .from('orders')
    .select('id, invoice_number')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return { invoice: null, invoiceNumber: null, error: 'order not found' };
  if (!order.invoice_number) return { invoice: null, invoiceNumber: null, error: 'This order has no QuickBooks invoice yet.' };
  const invoice = await getInvoiceByDocNumber(order.invoice_number);
  return { invoice, invoiceNumber: order.invoice_number };
}

function editableLines(inv: QBFullInvoice) {
  return (inv.Line || [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail' && l.Id)
    .map((l) => ({
      id: l.Id!,
      qb_item_id: l.SalesItemLineDetail?.ItemRef?.value ?? '',
      name: l.SalesItemLineDetail?.ItemRef?.name || l.Description || 'Item',
      qty: l.SalesItemLineDetail?.Qty ?? 0,
      unit_price: l.SalesItemLineDetail?.UnitPrice ?? 0,
      amount: l.Amount ?? 0,
    }));
}

export async function GET(req: Request) {
  const { supabase, error, status } = await requireAdmin();
  if (error) return NextResponse.json({ ok: false, error }, { status });

  const orderId = new URL(req.url).searchParams.get('order_id');
  if (!orderId) return NextResponse.json({ ok: false, error: 'order_id required' }, { status: 400 });

  try {
    const { invoice, invoiceNumber, error: e } = await loadInvoiceForOrder(supabase, orderId);
    if (e) return NextResponse.json({ ok: false, error: e }, { status: 400 });
    if (!invoice) return NextResponse.json({ ok: false, error: `Invoice #${invoiceNumber} not found in QuickBooks.` }, { status: 404 });
    // Also return the QB item catalog so the editor can change/add products.
    let items: { id: string; name: string; unit_price: number | null }[] = [];
    try {
      items = (await listAllItems()).map((i) => ({ id: i.Id, name: i.Name, unit_price: i.UnitPrice ?? null }));
    } catch { /* picker just won't have options; line edits still work */ }
    // Current sales-tax state: is any sales-item line marked taxable in QB?
    const chargeTax = (invoice.Line || []).some(
      (l) => l.DetailType === 'SalesItemLineDetail'
        && (l.SalesItemLineDetail as { TaxCodeRef?: { value?: string } } | undefined)?.TaxCodeRef?.value === 'TAX',
    );
    return NextResponse.json({ ok: true, invoice_number: invoiceNumber, lines: editableLines(invoice), items, charge_tax: chargeTax });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'QuickBooks request failed' }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const { supabase, error, status, actorName } = await requireAdmin();
  if (error) return NextResponse.json({ ok: false, error }, { status });

  let body: {
    order_id?: string;
    edits?: Record<string, { qty?: number; unitPrice?: number }>;
    lines?: DesiredLine[];  // full desired set (change/add/delete)
    charge_tax?: boolean;   // add/remove sales tax on the rebuilt invoice
  };
  try { body = await req.json(); } catch { body = {}; }
  const hasLines = Array.isArray(body.lines) && body.lines.length > 0;
  const hasEdits = body.edits && Object.keys(body.edits).length > 0;
  if (!body.order_id || (!hasLines && !hasEdits)) {
    return NextResponse.json({ ok: false, error: 'order_id and lines (or edits) required' }, { status: 400 });
  }

  try {
    const { invoice, invoiceNumber, error: e } = await loadInvoiceForOrder(supabase, body.order_id);
    if (e) return NextResponse.json({ ok: false, error: e }, { status: 400 });
    if (!invoice) return NextResponse.json({ ok: false, error: `Invoice #${invoiceNumber} not found in QuickBooks.` }, { status: 404 });

    // Full rebuild (change/add/delete) when `lines` is given; otherwise the
    // legacy qty/price-only edit path.
    const updated = hasLines
      ? await rebuildInvoiceLines(invoice, body.lines!, body.charge_tax)
      : await updateInvoiceLines(invoice, body.edits!);

    // Remember the choice on the linked customer order so re-invoicing keeps it.
    if (typeof body.charge_tax === 'boolean') {
      await createAdminClient().from('customer_orders')
        .update({ charge_tax: body.charge_tax }).eq('dispatched_order_id', body.order_id);
    }

    // Re-download the corrected PDF and replace the stored one.
    let pdfPath: string | null = null;
    try {
      const fresh = await getInvoiceById(updated.Id); // ensure latest
      const pdfBytes = await fetchInvoicePdf(updated.Id);
      const docLabel = fresh?.DocNumber || updated.DocNumber || updated.Id;
      pdfPath = `${body.order_id}/qb-invoice-${docLabel}.pdf`;
      await supabase.storage.from('invoices').upload(pdfPath, pdfBytes, {
        contentType: 'application/pdf', upsert: true,
      });
    } catch (pdfErr) {
      // The QB edit succeeded; only the PDF refresh failed. Still record who edited.
      await supabase.from('orders')
        .update({ invoice_edited_by_name: actorName, invoice_edited_at: new Date().toISOString() })
        .eq('id', body.order_id);
      return NextResponse.json({
        ok: true, partial: true,
        warning: 'Invoice updated in QuickBooks, but the PDF refresh failed: ' + (pdfErr instanceof Error ? pdfErr.message : 'unknown'),
        total: updated.TotalAmt ?? null,
      });
    }

    await supabase.from('orders').update({
      invoice_pdf_path: pdfPath,
      invoice_edited_by_name: actorName,
      invoice_edited_at: new Date().toISOString(),
    }).eq('id', body.order_id);

    return NextResponse.json({ ok: true, total: updated.TotalAmt ?? null, invoice_pdf_path: pdfPath });
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'QuickBooks update failed';
    // 6270: one of the invoice's inventory-tracked (QOH) products has an
    // Inventory Start Date later than the invoice date. The app already retries
    // by moving the invoice to today's date (postInvoiceUpdate); if it still
    // fails, the item's start date is today or later and must be fixed in QB.
    if (/6270|prior to start date/i.test(raw)) {
      return NextResponse.json({ ok: false, error:
        "QuickBooks rejected this: one or more products on the invoice are inventory-tracked "
        + "(quantity on hand), and their Inventory Start Date in QuickBooks is later than the "
        + "invoice date — QB won't sell an inventory item before its start date. The app already "
        + "tried dating the invoice today and QB still refused, so that start date is today or "
        + "later. Fix it in QuickBooks: Products & Services -> open each inventory item on this "
        + "invoice (e.g. the DEF drum, Hydrex AW32 hydraulic, Windshield Wash) -> set its "
        + "inventory \"As of\" / start date to an earlier date (e.g. the start of the year) -> "
        + "Save, then try the adjustment again."
      }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: raw }, { status: 502 });
  }
}
