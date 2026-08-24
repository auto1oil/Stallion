// ============================================================================
// Core "invoice a customer_order in QuickBooks" routine.
// ============================================================================
// Extracted from app/api/quickbooks/invoice so it can be reused both by that
// (admin-triggered) route and by the auto-post route that fires when a
// flagged customer's staff-placed order skips approval. Takes any Supabase
// client (the admin route passes its user-scoped client; auto-post passes the
// service-role client) plus the order id and optional per-line price overrides.
// Returns { status, body } so callers can map straight onto an HTTP response.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QBItem } from '@/lib/quickbooks';
import {
  findCustomerByName,
  searchCustomers,
  createCustomer,
  getActiveCustomer,
  reFindActiveCustomer,
  isQbAuthError,
  listAllItems,
  findItemByName,
  createInvoice,
  reactivateItem,
  getItemUnitPrice,
  getCustomerHistoryItems,
  fetchInvoicePdf,
  getCustomerSalesTermId,
  type HistoryItem,
} from '@/lib/quickbooks';

// Tokens that appear in dozens of unrelated QB items (container/unit sizes
// and small numbers). If we let these contribute to the fuzzy score, every
// "*GAL*" cart line matches every "*GAL*" QB item — that's how "Clear Fuel
// BULK GAL" was matching "GAL:AUTO 1 FULL SYNTHETIC 5W-30" with score 1.
const FUZZY_STOPWORDS = new Set([
  'gal', 'gals', 'bulk', 'qt', 'qts', 'cs', 'case', 'pail', 'pails',
  'drum', 'drums', 'pkg', 'pack', 'oz', 'lb',
  '1', '2', '3', '4', '5', '6', '12', '24', '55', '275',
]);

// Token-overlap score with stopwords removed.
function fuzzyScore(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !FUZZY_STOPWORDS.has(t));
  const aTokens = norm(a);
  const bSet = new Set(norm(b));
  let hits = 0;
  for (const t of aTokens) if (bSet.has(t)) hits++;
  return hits;
}

// Require at least 2 non-stopword tokens to overlap before we trust a
// history match. One-token matches are almost always coincidental
// (e.g. matching on "BLUE" or "GAL") and were causing fuel cart lines
// to map to motor oil QB items.
const MIN_HISTORY_MATCH_SCORE = 2;

function bestHistoryMatch(
  history: HistoryItem[],
  cartLineLabel: string,
): HistoryItem | null {
  let best: { item: HistoryItem; score: number } | null = null;
  for (const h of history) {
    const s = fuzzyScore(cartLineLabel, h.qbItemName);
    if (s >= MIN_HISTORY_MATCH_SCORE && (!best || s > best.score)) {
      best = { item: h, score: s };
    }
  }
  return best?.item ?? null;
}

export type InvoiceResult = { status: number; body: Record<string, unknown> };

// The fuel order screen stores "Loading rack: X · Fuel account: Y" in a fuel
// line's notes — internal routing (which terminal rack, which supplier account)
// that must NOT appear on the customer's invoice. Strip that segment; keep any
// other note text. Returns undefined when nothing customer-facing remains.
export function invoiceLineNote(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  const cleaned = notes
    .replace(/\s*Loading rack:\s*.+?\s*·\s*Fuel account:\s*[^\n]*/i, '')
    .trim();
  return cleaned || undefined;
}

export async function invoiceCustomerOrder(
  supabase: SupabaseClient,
  customerOrderId: string,
  fuelPrices: Record<string, number> = {},
): Promise<InvoiceResult> {
  // 3) Load the order, items, and customer
  const { data: order, error: orderErr } = await supabase
    .from('customer_orders')
    .select('id, status, invoice_number, notes, customer_id, sales_rep_id, payment_term_id, po_number, charge_tax')
    .eq('id', customerOrderId)
    .maybeSingle();
  if (orderErr || !order) {
    return { status: 404, body: { ok: false, error: 'order not found' } };
  }
  if (order.status === 'invoiced' || order.status === 'dispatched') {
    return { status: 400, body: { ok: false, error: `order already ${order.status}` } };
  }

  const { data: items, error: itemsErr } = await supabase
    .from('customer_order_items')
    .select('id, product_id, product_name, container_size, brand, weight, quantity, notes, unit_price')
    .eq('customer_order_id', order.id);

  if (itemsErr || !items || items.length === 0) {
    return { status: 400, body: { ok: false, error: 'order has no items' } };
  }

  const { data: customer, error: custErr } = await supabase
    .from('profiles')
    .select('id, email, full_name, business_name, phone, address, business_id')
    .eq('id', order.customer_id)
    .single();
  if (custErr || !customer) {
    return { status: 404, body: { ok: false, error: 'customer profile not found' } };
  }

  // Pull the linked Business (if any). Multiple profiles can share a
  // business, so the QB customer / invoice address come from the Business
  // record — not from the individual user's profile fields.
  let business: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    qb_customer_id: string | null;
    assigned_sales_rep_id: string | null;
  } | null = null;
  if (customer.business_id) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, address, phone, qb_customer_id, assigned_sales_rep_id')
      .eq('id', customer.business_id)
      .single();
    business = (biz as typeof business) || null;
  }

  // Salesman name → written to the invoice's salesman custom field. Use the
  // customer's ASSIGNED rep (who earns the commission), falling back to whoever
  // placed the order.
  let salesmanName: string | undefined;
  let salesmanClass: string | undefined;
  const repId = business?.assigned_sales_rep_id || order.sales_rep_id || null;
  if (repId) {
    const { data: rep } = await supabase.from('profiles').select('full_name, email, qb_class').eq('id', repId).maybeSingle();
    salesmanName = (rep?.full_name || rep?.email) || undefined;
    salesmanClass = (rep?.qb_class as string | null) || undefined;
  }

  // Tax-exempt check: TC-721 might be uploaded under ANY member of the
  // business (e.g. the owner uploaded it; a manager places the order).
  // So we look across every profile sharing this business_id.
  let customerTaxExempt = false;
  {
    let profileIds: string[] = [order.customer_id];
    if (business) {
      const { data: members } = await supabase
        .from('profiles')
        .select('id')
        .eq('business_id', business.id);
      const ids = (members || []).map((m) => m.id);
      if (ids.length > 0) profileIds = ids;
    }
    const { count } = await supabase
      .from('customer_documents')
      .select('id', { count: 'exact', head: true })
      .in('customer_id', profileIds)
      .eq('doc_type', 'tax_exempt');
    customerTaxExempt = (count ?? 0) > 0;
  }

  // 4) Resolve QB customer (business.qb_customer_id → mapping → searched → created)
  let qbCustomerId: string | null = null;
  let qbCustomerName: string | null = null;
  try {
    if (business?.qb_customer_id) {
      // The stored id can point at a customer that was merged away in QuickBooks
      // (which deletes the merged record) — invoicing it fails with "customer has
      // been deleted". Verify it's still active; if not, re-find the live
      // customer by email/name and heal the stored id.
      const active = await getActiveCustomer(business.qb_customer_id);
      if (active) {
        qbCustomerId = active.Id;
        qbCustomerName = active.DisplayName || business.name;
      } else {
        const reFound = await reFindActiveCustomer({ name: business.name || customer.business_name });
        if (!reFound) {
          return { status: 500, body: { ok: false, error: `customer step: the QuickBooks customer linked to "${business.name}" was deleted (likely merged in QuickBooks) and no active customer with that name was found. Open the order's Customer card and use "Re-link QB" to point it at the right QuickBooks customer.` } };
        }
        qbCustomerId = reFound.Id;
        qbCustomerName = reFound.DisplayName;
        await supabase.from('businesses').update({ qb_customer_id: reFound.Id }).eq('id', business.id);
      }
    } else {
      const { data: mapping } = await supabase
        .from('customer_qb_mapping')
        .select('qb_customer_id, qb_customer_name')
        .eq('profile_id', customer.id)
        .maybeSingle();

      if (mapping) {
        qbCustomerId = mapping.qb_customer_id;
        qbCustomerName = mapping.qb_customer_name;
      } else {
        const displayName =
          business?.name || customer.business_name || customer.full_name || customer.email;
        // Match an existing QuickBooks customer by NAME only (many customers have
        // no email, so email is unreliable). Exact name first, then a
        // case-insensitive search so a slight capitalization/format difference
        // still links instead of creating a duplicate.
        let existing = await findCustomerByName(displayName);
        if (!existing) {
          const token = displayName.split(/[\s,]+/)[0];
          if (token && token.length >= 2) {
            const cands = await searchCustomers(token);
            const want = displayName.toLowerCase();
            existing = cands.find((c) => (c.DisplayName || '').toLowerCase() === want) ?? null;
          }
        }
        const realEmail = customer.email && !customer.email.endsWith('@auto1oil.local') ? customer.email : null;
        const qbCust = existing ?? await createCustomer({
          displayName,
          email: realEmail,
          phone: business?.phone || customer.phone,
          companyName: business?.name || customer.business_name,
          billAddress: business?.address || customer.address,
        });
        qbCustomerId = qbCust.Id;
        qbCustomerName = qbCust.DisplayName;

        // Cache on the Business too so future orders skip lookup.
        if (business) {
          await supabase
            .from('businesses')
            .update({ qb_customer_id: qbCust.Id })
            .eq('id', business.id);
        }
        await supabase.from('customer_qb_mapping').upsert({
          profile_id: customer.id,
          qb_customer_id: qbCust.Id,
          qb_customer_name: qbCust.DisplayName,
          updated_at: new Date().toISOString(),
        });
      }
    }
  } catch (e: any) {
    if (isQbAuthError(e)) {
      return { status: 502, body: { ok: false, error: 'QuickBooks connection problem — its authorization has expired. Reconnect it (Dashboard → QuickBooks → Reconnect), then try again. The customer is fine; no re-link needed.' } };
    }
    return { status: 500, body: { ok: false, error: `customer step: ${e.message}` } };
  }

  if (!qbCustomerId) {
    return { status: 500, body: { ok: false, error: 'could not resolve QB customer' } };
  }


  // 5b) Pull this customer's billing history from QB ONCE.
  const history = await getCustomerHistoryItems(qbCustomerId, 25);

  // 6) Resolve QB item for each line + figure out unit price
  const lines: Array<{
    qbItemId: string;
    qbItemName: string;
    quantity: number;
    unitPrice?: number;
    description?: string;
    taxLine?: boolean;
    matchedVia?: 'mapping' | 'history' | 'name' | 'auto-created';
  }> = [];

  // Index the active QB item catalog by the word-set of each item's name, so we
  // reuse the REAL configured item even when our constructed name orders the
  // packaging differently — we build "SUPREME UHP DEXOS 0W-20 GAL" while
  // QuickBooks names it "GAL:SUPREME UHP DEXOS 0W-20". Both have the same words.
  // When two items share a word-set, prefer the one that actually carries a cost
  // or price (the real item) over a $0 placeholder duplicate.
  const allQbItems = await listAllItems();
  const wordKey = (s: string) =>
    Array.from(new Set((s || '').toLowerCase().replace(/[:]/g, ' ').split(/\s+/).filter(Boolean)))
      .sort().join(' ');
  const itemScore = (q: QBItem) =>
    (q.PurchaseCost != null ? 1 : 0) + (q.UnitPrice != null && q.UnitPrice > 0 ? 1 : 0);
  const itemByWords = new Map<string, QBItem>();
  for (const qi of allQbItems) {
    const k = wordKey(qi.FullyQualifiedName || qi.Name || '');
    const ex = itemByWords.get(k);
    if (!ex || itemScore(qi) > itemScore(ex)) itemByWords.set(k, qi);
  }

  // Also index the active catalog by SKU, to resolve a matched inventory item
  // via its SKU when the names don't word-match.
  const itemBySku = new Map<string, QBItem>();
  for (const qi of allQbItems) {
    const sk = (qi.Sku || '').trim().toLowerCase();
    if (sk && !itemBySku.has(sk)) itemBySku.set(sk, qi);
  }

  try {
    for (const it of items) {
      const weight = it.weight || '';
      const containerSize = it.container_size || '';
      // "Other" is a placeholder packaging (no real container), so a line like
      // TRUCKING + "Other" must match the plain "TRUCKING" QB item — not look for
      // a nonexistent "TRUCKING Other". Drop it from the name we match on (the
      // real weight/container_size are still used as the mapping key below).
      const nameOnly = (v: string) => (v && v.trim().toLowerCase() === 'other' ? '' : v);
      const qbItemFullName = [
        it.product_name,
        nameOnly(weight),
        nameOnly(containerSize),
      ].filter(Boolean).join(' ');

      let qbItemId: string | null = null;
      let qbItemName: string | null = null;
      let matchedVia: 'mapping' | 'history' | 'name' | 'auto-created' = 'auto-created';
      let historyUnitPrice: number | null = null;

      // 0) The QuickBooks item the admin explicitly MATCHED this product to on
      //    the Inventory page, resolved to its ACTIVE catalog entry (by name,
      //    then SKU). Highest priority — it sidesteps stale mappings that point
      //    at deleted/duplicate items, the cause of "activate this item" and
      //    "transaction date prior to start date" errors on items that look fine.
      const matched: { qbName: string; sku: string | null } | undefined = undefined;
      if (matched) {
        const activeItem =
          itemByWords.get(wordKey(matched.qbName)) ||
          (matched.sku ? itemBySku.get(matched.sku.trim().toLowerCase()) : null) ||
          null;
        if (activeItem) {
          qbItemId = activeItem.Id;
          qbItemName = activeItem.Name;
          matchedVia = 'name';
          if (it.product_id) {
            await supabase.from('product_qb_mapping').upsert({
              product_id: it.product_id,
              weight,
              container_size: containerSize,
              qb_item_id: activeItem.Id,
              qb_item_name: activeItem.Name,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'product_id,weight,container_size' });
          }
        }
      }

      // Prefer the real, ACTIVE QuickBooks item whose name uses the same words
      // (ignoring packaging order) and that carries a cost or price. This wins
      // over any stale mapping/history, so we never reference a $0 placeholder
      // or a deleted duplicate ("...0W-20 GAL (deleted-1)"). Heal the mapping.
      const preferred = itemByWords.get(wordKey(qbItemFullName));
      if (!qbItemId && preferred && itemScore(preferred) > 0) {
        qbItemId = preferred.Id;
        qbItemName = preferred.Name;
        matchedVia = 'name';
        if (it.product_id) {
          await supabase.from('product_qb_mapping').upsert({
            product_id: it.product_id,
            weight,
            container_size: containerSize,
            qb_item_id: preferred.Id,
            qb_item_name: preferred.Name,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'product_id,weight,container_size' });
        }
      }

      if (!qbItemId && it.product_id) {
        const { data: map } = await supabase
          .from('product_qb_mapping')
          .select('qb_item_id, qb_item_name')
          .eq('product_id', it.product_id)
          .eq('weight', weight)
          .eq('container_size', containerSize)
          .maybeSingle();
        if (map) {
          qbItemId = map.qb_item_id;
          qbItemName = map.qb_item_name;
          matchedVia = 'mapping';
        }
      }

      if (!qbItemId && history.length > 0) {
        const hit = bestHistoryMatch(history, qbItemFullName);
        if (hit) {
          qbItemId = hit.qbItemId;
          qbItemName = hit.qbItemName;
          historyUnitPrice = hit.lastUnitPrice;
          matchedVia = 'history';
          if (it.product_id) {
            await supabase.from('product_qb_mapping').upsert(
              {
                product_id: it.product_id,
                weight,
                container_size: containerSize,
                qb_item_id: qbItemId,
                qb_item_name: qbItemName,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'product_id,weight,container_size' },
            );
          }
        }
      }

      if (!qbItemId) {
        // Only ever use a real QuickBooks item — never invent one. Try the
        // exact/leaf name, then the word-set match (any active item, even one
        // with no price set). If nothing in QuickBooks matches, stop with a
        // clear message instead of creating a $0 placeholder.
        const existing =
          (await findItemByName(qbItemFullName)) ||
          itemByWords.get(wordKey(qbItemFullName)) ||
          null;
        if (!existing) {
          return {
            status: 400,
            body: {
              ok: false,
              error: `"${qbItemFullName}" isn't a product in QuickBooks. The app no longer creates items. Add it in QuickBooks (Sales → Products & services), run "Sync prices & stock from QuickBooks" on the Inventory page, then create the invoice.`,
            },
          };
        }
        qbItemId = existing.Id;
        qbItemName = existing.Name;
        matchedVia = 'name';
        if (it.product_id) {
          await supabase.from('product_qb_mapping').upsert({
            product_id: it.product_id,
            weight,
            container_size: containerSize,
            qb_item_id: qbItemId,
            qb_item_name: qbItemName,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'product_id,weight,container_size' });
        }
      }

      // Resolve the unit price for this line. Priority: the price an admin set
      // on the order line → a per-line override passed in (manual invoice
      // screen) → this customer's QB history → the QB item's catalog price.
      const adminPrice = (it as { unit_price?: number | null }).unit_price;
      const userPrice = fuelPrices[it.id];
      let unitPrice: number;
      if (typeof adminPrice === 'number' && Number.isFinite(adminPrice) && adminPrice >= 0) {
        unitPrice = adminPrice;
      } else if (typeof userPrice === 'number' && Number.isFinite(userPrice) && userPrice >= 0) {
        unitPrice = userPrice;
      } else if (historyUnitPrice != null) {
        unitPrice = historyUnitPrice;
      } else {
        const p = await getItemUnitPrice(qbItemId!);
        unitPrice = p ?? 0;
      }

      lines.push({
        qbItemId: qbItemId!,
        qbItemName: qbItemName!,
        quantity: it.quantity,
        description: invoiceLineNote(it.notes),
        matchedVia,
        unitPrice,
      });
    }
  } catch (e: any) {
    return { status: 500, body: { ok: false, error: `items step: ${e.message}` } };
  }

  // 7) Resolve the payment terms to print on the invoice: whatever the rep
  // chose on the order, else the customer's saved QB terms (their account
  // default, e.g. Credit Card / Check on Delivery / Due Upon Receipt).
  let salesTermId: string | undefined;
  let termsSource: string;
  let termsWarning: string | null = null;
  try {
    if (order.payment_term_id) {
      // Rep explicitly chose terms on the place-order screen — honor it.
      salesTermId = order.payment_term_id;
      termsSource = 'chosen at order';
    } else {
      salesTermId = (await getCustomerSalesTermId(qbCustomerId)) || undefined;
      termsSource = salesTermId ? 'customer default' : 'none';
    }
  } catch (e: any) {
    termsSource = 'none';
    termsWarning = `terms lookup failed: ${e.message}`;
  }

  // 8) Create the invoice in QB
  const invoiceArgs = {
    qbCustomerId,
    lines,
    customerMemo: order.notes || undefined,
    salesTermId,
    poNumber: order.po_number || undefined,
    salesmanName,
    salesmanClass,
    // Default no sales tax (most customers are exempt); charge it only when
    // the order is explicitly flagged taxable.
    taxable: order.charge_tax === true,
  };
  let invoice;
  try {
    invoice = await createInvoice(invoiceArgs);
  } catch (e: any) {
    const raw = e?.message || String(e);
    // 2390: a line item in QuickBooks has no income account (or isn't marked
    // "I sell this"). QB won't invoice it until that's fixed on the item.
    if (/2390|no income account|marked for sale/i.test(raw)) {
      const m = raw.match(/item \\?"([^"\\]+)\\?"/);
      const itemName = m ? m[1] : 'one of the products';
      return { status: 400, body: { ok: false, error:
        `QuickBooks won't invoice "${itemName}" because it has no income account. In QuickBooks -> Sales -> Products & services, edit that item, check "I sell this product/service", pick an Income account, Save, then try again.` } };
    }
    // 6000 "You need to activate this item before updating the quantity": one or
    // more of the invoice's items are archived (inactive) in QuickBooks. Do what
    // QB asks — reactivate the invoice's items, then retry once.
    if (/activate this item|"code"\s*:\s*"?6000/i.test(raw)) {
      const uniqueIds = Array.from(new Set(lines.map((l) => l.qbItemId).filter(Boolean)));
      const reactivated: string[] = [];
      for (const id of uniqueIds) {
        try {
          const r = await reactivateItem(id as string);
          if (r.reactivated) reactivated.push(r.name);
        } catch { /* best-effort — keep trying the rest */ }
      }
      if (reactivated.length === 0) {
        // Every item the app referenced came back active, yet QB still rejected
        // with "activate this item". That almost always means a line is mapped
        // to a DELETED/duplicate QuickBooks item (QB can hide those) while a
        // separate active item of the same name exists. Name what we used so
        // the duplicate is findable.
        const used = Array.from(new Set(lines.map((l) => l.qbItemName).filter(Boolean)));
        return { status: 400, body: { ok: false, error:
          `QuickBooks rejected the invoice with "activate this item before updating the quantity", but the items the app used all report as active: ${used.join(', ')}. This usually means one of these order lines is mapped to a deleted/duplicate item in QuickBooks. Re-match the line(s) to the correct item, or merge the duplicate in QuickBooks, then try again.` } };
      }
      try {
        invoice = await createInvoice(invoiceArgs);
      } catch (e2: any) {
        return { status: 400, body: { ok: false, error:
          `Reactivated ${reactivated.join(', ')} in QuickBooks, but the invoice still failed: ${e2?.message || String(e2)}` } };
      }
    } else {
      return { status: 500, body: { ok: false, error: `invoice create: ${raw}` } };
    }
  }

  // 8) Download the rendered invoice PDF and stash it in storage.
  let pdfPath: string | null = null;
  let pdfWarning: string | null = null;
  try {
    const pdfBytes = await fetchInvoicePdf(invoice.Id);
    const docLabel = invoice.DocNumber || invoice.Id;
    pdfPath = `${order.id}/qb-invoice-${docLabel}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('invoices')
      .upload(pdfPath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) {
      pdfWarning = `PDF upload failed: ${upErr.message}`;
      pdfPath = null;
    }
  } catch (e: any) {
    pdfWarning = `PDF fetch failed: ${e.message || 'unknown'}`;
  }

  // 9) Write back to customer_orders
  const invoiceNumber = invoice.DocNumber || invoice.Id;
  const updPayload: Record<string, any> = {
    status: 'invoiced',
    invoice_number: invoiceNumber,
    invoiced_at: new Date().toISOString(),
  };
  if (pdfPath) updPayload.invoice_pdf_path = pdfPath;

  const { error: updErr } = await supabase
    .from('customer_orders')
    .update(updPayload)
    .eq('id', order.id);
  if (updErr) {
    return {
      status: 500,
      body: {
        ok: false,
        error: `invoice was created in QB (id=${invoice.Id}) but DB update failed: ${updErr.message}`,
      },
    };
  }

  const matchSummary = {
    mapping:      lines.filter((l) => l.matchedVia === 'mapping').length,
    history:      lines.filter((l) => l.matchedVia === 'history').length,
    name:         lines.filter((l) => l.matchedVia === 'name').length,
    auto_created: lines.filter((l) => l.matchedVia === 'auto-created').length,
  };

  return {
    status: 200,
    body: {
      ok: true,
      invoice: {
        id: invoice.Id,
        docNumber: invoice.DocNumber,
        totalAmt: invoice.TotalAmt,
      },
      customer: { id: qbCustomerId, name: qbCustomerName },
      lines_count: lines.length,
      matched: matchSummary,
      customer_tax_exempt: customerTaxExempt,
      pdf_attached: pdfPath != null,
      pdf_warning: pdfWarning,
      terms: termsSource,
      terms_warning: termsWarning,
      invoice_number: invoiceNumber,
      invoice_pdf_path: pdfPath,
    },
  };
}
