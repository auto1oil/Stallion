// The haul ticket as a PDF — the digital twin of the paper ticket.
//
// Generated server-side when a ticket is approved/invoiced, stored next to the
// ticket's photos in the work-tickets bucket, attached to the QuickBooks
// invoice, and linked in the factoring hand-off.
//
// Deliberately carries NO money. The same document rides with the customer's
// invoice and the hauler's factoring packet, and each side's rate is none of
// the other's business — the invoice itself is where the money lives. What
// this documents is the WORK: who hauled what, where, when, and who signed.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  onSiteHours, totalHours, totalLoadTons, countLoads,
  type WorkOrder, type WorkOrderLoad,
} from '@/lib/work-orders';

const BUCKET = 'work-tickets';

const INK = rgb(0.1, 0.1, 0.12);
const FAINT = rgb(0.45, 0.45, 0.5);
const LINE = rgb(0.8, 0.8, 0.84);

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Build the PDF bytes for one ticket.
export async function buildTicketPdf(
  db: SupabaseClient,
  wo: WorkOrder,
  loads: WorkOrderLoad[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const left = 40;
  const right = 572;
  let y = 752;

  const text = (s: string, x: number, size = 9, f: PDFFont = font, color = INK) => {
    page.drawText(s, { x, y, size, font: f, color });
  };
  const rule = (yy: number) => {
    page.drawLine({ start: { x: left, y: yy }, end: { x: right, y: yy }, thickness: 0.75, color: LINE });
  };

  // ---- Header ----
  text('STALLION TANK', left, 18, bold);
  page.drawText('HAUL TICKET', { x: left + 160, y: y + 4, size: 11, font: bold, color: FAINT });
  if (wo.ticket_number) {
    page.drawText(`Ticket #${wo.ticket_number}`, { x: right - 130, y: y + 6, size: 10, font: bold, color: INK });
  }
  if (wo.job_date) {
    page.drawText(wo.job_date, { x: right - 130, y: y - 6, size: 9, font, color: FAINT });
  }
  y -= 22;
  rule(y); y -= 16;

  // ---- Fact grid: label over value, four columns ----
  const facts: [string, string | null][] = [
    ['Trucking company', wo.trucking_company],
    ['Driver', wo.driver_name],
    ['Unit #', wo.unit_number],
    ['Equipment', wo.equipment_type],
    ['Customer #', wo.customer_number],
    ['Job #', wo.job_number],
    ['Job name', wo.job_name],
    ['Phase', wo.phase_code],
    ['Job address', wo.job_address],
    ['FSR', wo.fsr],
    ['Claim #', wo.claim_number],
    ['Day #', wo.day_number],
    ['Material', wo.material],
    ['Supplier', wo.supplier],
    ['Truck type', wo.truck_type],
    ['Truck tons', wo.truck_type_tons != null ? String(wo.truck_type_tons) : null],
  ];
  const filled = facts.filter(([, v]) => v && String(v).trim() !== '');
  const colW = (right - left) / 4;
  filled.forEach(([k, v], i) => {
    const col = i % 4;
    if (col === 0 && i > 0) y -= 30;
    const x = left + col * colW;
    page.drawText(k.toUpperCase(), { x, y, size: 6.5, font, color: FAINT });
    const value = String(v).slice(0, 34);
    page.drawText(value, { x, y: y - 11, size: 9, font: bold, color: INK });
  });
  y -= 30 + 12;
  rule(y); y -= 16;

  // ---- The day's times ----
  const hrs = totalHours(wo);
  const times: [string, string][] = [
    ['Start', fmtDateTime(wo.start_at)],
    ['Stop', fmtDateTime(wo.stop_at)],
    ['On site', `${onSiteHours(wo.start_at, wo.stop_at).toFixed(2)} h`],
    ['Travel', `${Number(wo.travel_hours || 0).toFixed(2)} h`],
    ['Down', `${Number(wo.down_hours || 0).toFixed(2)} h`],
    ['Total', `${hrs.toFixed(2)} h`],
  ];
  times.forEach(([k, v], i) => {
    const x = left + i * ((right - left) / 6);
    page.drawText(k.toUpperCase(), { x, y, size: 6.5, font, color: FAINT });
    page.drawText(v || '—', { x, y: y - 11, size: 9, font: i === 5 ? bold : font, color: INK });
  });
  y -= 30;
  if (wo.signed_out_state || wo.sign_out_at) {
    page.drawText(
      `Signed out ${wo.signed_out_state || ''} ${fmtDateTime(wo.sign_out_at)}`.trim(),
      { x: left, y, size: 8, font, color: FAINT },
    );
    y -= 14;
  }
  rule(y); y -= 16;

  // ---- Load lines ----
  const ran = loads.filter((l) => l.load_in_at || l.load_out_at || l.unload_in_at || l.unload_out_at || Number(l.tons || 0) > 0);
  if (ran.length > 0) {
    page.drawText('LOADS', { x: left, y, size: 7.5, font: bold, color: FAINT });
    y -= 13;
    const cols = [left, left + 30, left + 110, left + 190, left + 270, left + 350, left + 430, right - 40];
    const heads = ['#', 'Ticket #', 'Load in', 'Load out', 'Unload in', 'Unload out', '', 'Tons'];
    heads.forEach((h, i) => {
      if (h) page.drawText(h, { x: cols[i], y, size: 7, font, color: FAINT });
    });
    y -= 11;
    for (const l of ran) {
      const row = [
        String(l.load_no),
        l.ticket_number || '',
        fmtTime(l.load_in_at),
        fmtTime(l.load_out_at),
        fmtTime(l.unload_in_at),
        fmtTime(l.unload_out_at),
        '',
        l.tons != null ? Number(l.tons).toFixed(2) : '',
      ];
      row.forEach((c, i) => {
        if (c) page.drawText(c, { x: cols[i], y, size: 8.5, font, color: INK });
      });
      y -= 12;
      if (y < 150) break; // never off the page — the row data lives in the app
    }
    page.drawText(
      `${countLoads(ran)} loads · ${totalLoadTons(ran).toFixed(2)} tons`,
      { x: left, y, size: 9, font: bold, color: INK },
    );
    y -= 16;
  } else if (wo.tonnage != null && Number(wo.tonnage) > 0) {
    page.drawText(
      `Tonnage: ${Number(wo.tonnage).toFixed(2)} ${wo.tonnage_type || ''}`.trim(),
      { x: left, y, size: 9, font: bold, color: INK },
    );
    y -= 16;
  }
  rule(y); y -= 14;

  // ---- Notes ----
  if (wo.notes) {
    page.drawText('NOTES', { x: left, y, size: 7.5, font: bold, color: FAINT });
    y -= 12;
    // Rough wrap — enough for a few lines of field notes.
    const words = wo.notes.replace(/\s+/g, ' ').trim().split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).length > 100) {
        page.drawText(line, { x: left, y, size: 8.5, font, color: INK });
        y -= 11;
        line = w;
        if (y < 120) break;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line && y >= 120) { page.drawText(line, { x: left, y, size: 8.5, font, color: INK }); y -= 11; }
    y -= 6;
  }

  // ---- Signatures ----
  await drawSignature(db, doc, page, wo.signature_path, "DRIVER'S SIGNATURE", left, 46);
  await drawSignature(db, doc, page, wo.foreman_signature_path, "FOREMAN'S SIGNATURE", left + (right - left) / 2, 46);

  return doc.save();
}

// A signature block anchored at the bottom of the page: the PNG from storage
// above a line with its label. A missing or unreadable image just leaves the
// line — a PDF that fails over a signature fetch helps nobody.
async function drawSignature(
  db: SupabaseClient,
  doc: PDFDocument,
  page: PDFPage,
  path: string | null,
  label: string,
  x: number,
  baseline: number,
) {
  const width = 220;
  try {
    if (path) {
      const { data } = await db.storage.from(BUCKET).download(path);
      if (data) {
        const bytes = new Uint8Array(await data.arrayBuffer());
        const img = await doc.embedPng(bytes);
        const scale = Math.min(width / img.width, 46 / img.height);
        page.drawImage(img, {
          x, y: baseline + 4,
          width: img.width * scale,
          height: img.height * scale,
        });
      }
    }
  } catch { /* line + label still say who was meant to sign */ }
  page.drawLine({
    start: { x, y: baseline }, end: { x: x + width, y: baseline },
    thickness: 0.75, color: rgb(0.3, 0.3, 0.34),
  });
  page.drawText(label, { x, y: baseline - 10, size: 6.5, color: rgb(0.45, 0.45, 0.5) });
}

// Generate (or regenerate) the ticket's PDF, store it next to the ticket's
// photos, and remember the path on the row. Returns the storage path, or null
// when generation failed — callers treat that like any other best-effort miss.
export async function ensureTicketPdf(
  db: SupabaseClient,
  workOrderId: string,
): Promise<{ path: string; bytes: Uint8Array } | null> {
  try {
    const [{ data: row }, { data: loadRows }] = await Promise.all([
      db.from('work_orders').select('*').eq('id', workOrderId).maybeSingle(),
      db.from('work_order_loads').select('*').eq('work_order_id', workOrderId).order('load_no'),
    ]);
    if (!row) return null;
    const wo = row as WorkOrder;
    const bytes = await buildTicketPdf(db, wo, (loadRows as WorkOrderLoad[]) || []);

    const path = `work-orders/${workOrderId}/haul-ticket.pdf`;
    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(path, bytes as unknown as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
    if (upErr) return null;
    await db.from('work_orders').update({ ticket_pdf_path: path }).eq('id', workOrderId);
    return { path, bytes };
  } catch {
    return null;
  }
}
