// The haul ticket as a PDF — laid out to mirror the paper form it replaced:
// the company header, the field lines, the check-one truck-type grid, the
// ruled sixteen-row load table, the Job Time block with both signatures on
// their lines, and the gray office-use band.
//
// Generated server-side when a ticket is approved/invoiced or shared, stored
// next to the ticket's photos in the work-tickets bucket, attached to the
// QuickBooks invoice, and linked in the factoring hand-off.
//
// Deliberately carries NO rates or dollar amounts — same as the paper form.
// The same document rides with the customer's invoice, the hauler's
// factoring packet, and whoever the driver texts it to.

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  totalHours, totalLoadTons, countLoads,
  type WorkOrder, type WorkOrderLoad,
} from '@/lib/work-orders';

const BUCKET = 'work-tickets';

const INK = rgb(0, 0, 0);
const GRAY = rgb(0.85, 0.85, 0.85);

const fmtClock = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const mer = h >= 12 ? 'PM' : 'AM';
  h = ((h + 11) % 12) + 1;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${mer}`;
};
const fmtStamp = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(iso)}`;
};

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
  const serif = await doc.embedFont(StandardFonts.TimesRoman);

  const L = 36;   // outer box left
  const R = 576;  // outer box right

  const text = (s: string, x: number, y: number, size = 8, f: PDFFont = font) => {
    if (s) page.drawText(s, { x, y, size, font: f, color: INK });
  };
  const hline = (x1: number, x2: number, y: number, w = 0.7) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: w, color: INK });
  const vline = (x: number, y1: number, y2: number, w = 0.7) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: w, color: INK });
  // A labeled fill-in line, the backbone of the paper form: bold label, a
  // rule, and the value written on it.
  const fill = (label: string, x: number, lineEnd: number, y: number, value: string | null, labelSize = 8) => {
    text(label, x, y, labelSize, bold);
    const lx = x + bold.widthOfTextAtSize(label, labelSize) + 3;
    hline(lx, lineEnd, y - 1.5);
    if (value) text(String(value).slice(0, 60), lx + 2, y + 1, 8.5);
    return lx;
  };
  const checkbox = (x: number, y: number, label: string, checked: boolean, extra = '') => {
    page.drawRectangle({ x, y: y - 1, width: 8, height: 8, borderColor: INK, borderWidth: 0.8 });
    if (checked) text('X', x + 1.5, y + 0.5, 7.5, bold);
    text(label + extra, x + 12, y, 7.5, bold);
  };

  // ---- Header (outside the box, like the paper) ----
  text('150 North Main', L + 4, 762, 7.5, bold);
  text('St. Suite 102', L + 4, 753, 7.5, bold);
  text('Bountiful, UT 84010', L + 4, 744, 7.5, bold);
  text('Office@Stalliontank.com', L + 4, 735, 7, bold);
  const title = 'STALLION TANK LLC';
  const tw = serif.widthOfTextAtSize(title, 28);
  text(title, (612 - tw) / 2, 740, 28, serif);
  try {
    // Runtime-only import: this module is reachable from client bundles via
    // lib/work-orders, and a static 'fs' import breaks the build there. This
    // code only ever runs on the server.
    const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
    const logoBytes = await readFile(`${process.cwd()}/public/brand/stallion-mark.png`);
    const logo = await doc.embedPng(new Uint8Array(logoBytes));
    const s = Math.min(58 / logo.width, 58 / logo.height);
    page.drawImage(logo, { x: R - 62, y: 726, width: logo.width * s, height: logo.height * s });
  } catch { /* the words carry the header if the mark can't load */ }

  // ---- Outer box ----
  const boxTop = 716;
  const boxBottom = 42;
  page.drawRectangle({ x: L, y: boxBottom, width: R - L, height: boxTop - boxBottom, borderColor: INK, borderWidth: 1.2 });

  const heading = 'STALLION TANK HAUL TICKETS';
  const hw = bold.widthOfTextAtSize(heading, 10.5);
  text(heading, (612 - hw) / 2, boxTop - 16, 10.5, bold);

  // ---- Field lines ----
  const lx = L + 12;
  const mid = 372;
  let y = boxTop - 36;
  fill('Drivers Name', lx, mid - 20, y, wo.driver_name);
  fill('Date', mid, 468, y, wo.job_date);
  fill('Ticket #', 478, R - 10, y, wo.ticket_number);
  y -= 21;
  fill('Trucking Company', lx, mid - 20, y, wo.trucking_company);
  fill('Truck#', mid, R - 10, y, wo.unit_number);
  y -= 21;
  fill('Customer', lx, mid - 20, y, wo.customer_number);
  fill('Job#', mid, R - 10, y, wo.job_number);
  y -= 21;
  fill('Job Address', lx, mid - 20, y, wo.job_address);
  fill('Phase#', mid, R - 10, y, wo.phase_code);
  y -= 21;
  fill('Material', lx, 200, y, wo.material);
  fill('Supplier', 210, mid - 20, y, wo.supplier);
  text('Driver Time:', mid, y + 9, 6.5);
  fill('START', mid, 468, y, fmtClock(wo.driver_start_at), 7.5);
  fill('END', 478, R - 10, y, fmtClock(wo.driver_end_at), 7.5);

  // ---- Truck type: the check-one grid ----
  y -= 26;
  text('Truck Type:', lx, y, 8.5, bold);
  text('(Check One)', lx, y - 16, 6);
  const t = (wo.truck_type || '').trim();
  const col1 = 150; const col2 = 315; const col3 = 465;
  checkbox(col1, y, 'Truck & Pup', t === 'Truck & Pup');
  checkbox(col2, y, 'Double Belly', t === 'Double Belly');
  checkbox(col3, y, '6 Axel SS or DS', t === '6 Axel SS or DS');
  y -= 15;
  checkbox(col1, y, 'StrongArm', t === 'StrongArm',
    `___${t === 'StrongArm' && wo.truck_type_tons != null ? wo.truck_type_tons : ''}Tn`);
  checkbox(col2, y, 'Single Belly', t === 'Single Belly');
  checkbox(col3, y, 'Super Side', t === 'Super Side');
  y -= 15;
  checkbox(col1, y, 'End Dump', t === 'End Dump',
    `___${t === 'End Dump' && wo.truck_type_tons != null ? wo.truck_type_tons : ''}Tn`);
  checkbox(col2, y, 'Vacuum Trailer', t === 'Vacuum Trailer');
  checkbox(col3, y, 'Single Side', t === 'Single Side');
  y -= 17;
  // "Other" is for a truck type that isn't on the printed list — a checked
  // box already answers the question.
  const KNOWN = ['Truck & Pup', 'Double Belly', '6 Axel SS or DS', 'StrongArm', 'Single Belly', 'Super Side', 'End Dump', 'Vacuum Trailer', 'Single Side'];
  fill('Other:', lx + 24, R - 60, y, t && !KNOWN.includes(t) ? t : '', 7.5);

  // ---- The sixteen-line load table ----
  y -= 14;
  const cols = [48, 100, 210, 283, 356, 429, 502, 564];
  const groupH = 13;
  const headH = 13;
  const rowH = 15.2;
  const tableTop = y;
  // Group header: LOAD TIME over cols 2-3, UNLOAD TIME over 4-5, shaded.
  page.drawRectangle({ x: cols[2], y: tableTop - groupH, width: cols[4] - cols[2], height: groupH, color: GRAY });
  page.drawRectangle({ x: cols[4], y: tableTop - groupH, width: cols[6] - cols[4], height: groupH, color: GRAY });
  text('LOAD TIME', cols[2] + (cols[4] - cols[2]) / 2 - 24, tableTop - 10, 8);
  text('UNLOAD TIME', cols[4] + (cols[6] - cols[4]) / 2 - 29, tableTop - 10, 8);
  const headY = tableTop - groupH;
  const heads = ['Load #', 'Ticket #', 'IN', 'OUT', 'IN', 'OUT', 'TONS'];
  heads.forEach((h, i) => text(h, cols[i] + 3, headY - 10, i >= 2 && i <= 5 ? 8 : 7.5, bold));
  const bodyTop = headY - headH;
  const byNo = new Map(loads.map((l) => [l.load_no, l]));
  for (let i = 0; i < 16; i++) {
    const rowY = bodyTop - (i + 1) * rowH;
    const l = byNo.get(i + 1);
    text(String(i + 1), cols[0] + 20, rowY + 4, 8, bold);
    if (l) {
      text(l.ticket_number || '', cols[1] + 3, rowY + 4, 8);
      text(fmtClock(l.load_in_at), cols[2] + 3, rowY + 4, 8);
      text(fmtClock(l.load_out_at), cols[3] + 3, rowY + 4, 8);
      text(fmtClock(l.unload_in_at), cols[4] + 3, rowY + 4, 8);
      text(fmtClock(l.unload_out_at), cols[5] + 3, rowY + 4, 8);
      if (l.tons != null) text(Number(l.tons).toFixed(2), cols[6] + 3, rowY + 4, 8);
    }
  }
  const tableBottom = bodyTop - 16 * rowH;
  // Rules. The IN/OUT dividers stop under the group header, which spans them
  // — exactly how the paper table is ruled.
  for (const x of cols) {
    const top = x === cols[3] || x === cols[5] ? headY : tableTop;
    vline(x, tableBottom, top);
  }
  hline(cols[0], cols[7], tableTop);
  hline(cols[0], cols[7], headY);
  for (let i = 0; i <= 16; i++) hline(cols[0], cols[7], bodyTop - i * rowH);

  // ---- Job Time ----
  let jy = tableBottom - 14;
  text('Job Time:', L + 6, jy, 8.5, bold);
  jy -= 15;
  fill('Start Haul', lx, 150, jy, fmtClock(wo.start_at), 7.5);
  fill('End Haul', 158, 250, jy, fmtClock(wo.stop_at), 7.5);
  fill('Travel Time', 258, 348, jy, wo.travel_hours != null ? String(wo.travel_hours) : '', 7.5);
  fill('Downtime', 356, 438, jy, wo.down_hours != null ? String(wo.down_hours) : '', 7.5);
  fill('Total Hrs', 446, R - 10, jy, totalHours(wo) > 0 ? totalHours(wo).toFixed(2) : '', 7.5);
  jy -= 17;
  const sigImgW = 110; const sigImgH = 22;
  fill('Total Loads', lx, 170, jy, String(countLoads(loads) || ''), 7.5);
  fill('Total Tons Hauled', 178, 330, jy, totalLoadTons(loads) > 0 ? totalLoadTons(loads).toFixed(2) : '', 7.5);
  const dsx = fill('Drivers Signature', 338, R - 10, jy, '', 7.5);
  await drawSigOnLine(db, doc, page, wo.signature_path, dsx, jy, sigImgW, sigImgH);
  if (wo.signature_name) {
    text(`${wo.signature_name} · ${fmtStamp(wo.signature_signed_at)}`, dsx + 2, jy - 8, 6.5);
  }
  jy -= 19;
  text('Signed Out:', lx, jy, 8, bold);
  const so = wo.signed_out_state;
  text('Loaded', lx + 52, jy, 8, so === 'loaded' ? bold : font);
  if (so === 'loaded') hline(lx + 50, lx + 81, jy - 2, 1);
  text('Or', lx + 88, jy, 8);
  text('Empty', lx + 103, jy, 8, so === 'empty' ? bold : font);
  if (so === 'empty') hline(lx + 101, lx + 128, jy - 2, 1);
  fill('Sign Out Time', 182, 300, jy, fmtClock(wo.sign_out_at), 7.5);
  const fsx = fill('Foreman Signature', 338, R - 10, jy, '', 7.5);
  await drawSigOnLine(db, doc, page, wo.foreman_signature_path, fsx, jy, sigImgW, sigImgH);
  if (wo.foreman_signature_name) {
    text(`${wo.foreman_signature_name} · ${fmtStamp(wo.foreman_signature_signed_at)}`, fsx + 2, jy - 8, 6.5);
  }

  // ---- Office use band ----
  jy -= 15;
  page.drawRectangle({ x: L, y: jy - 20, width: R - L, height: 28, color: GRAY });
  text('Stallion Tank Office Use Only:', L + 6, jy, 8, bold);
  jy -= 13;
  fill('Start Haul', lx, 150, jy, fmtClock(wo.office_start_haul), 7.5);
  fill('End Haul', 158, 260, jy, fmtClock(wo.office_end_haul), 7.5);
  fill('Travel Time', 268, 390, jy, wo.office_travel_hours != null ? String(wo.office_travel_hours) : '', 7.5);
  fill('Total Hrs Billed', 398, R - 10, jy, wo.office_total_hours != null ? String(wo.office_total_hours) : '', 7.5);

  // ---- Comments ----
  jy -= 16;
  text('Comments:', L + 6, jy, 8.5, bold);
  const commentTop = jy - 4;
  const notes = [wo.notes, wo.office_comments].filter(Boolean).join('  ·  ');
  const words = notes ? notes.replace(/\s+/g, ' ').trim().split(' ') : [];
  let line = '';
  let li = 0;
  const commentLines: string[] = [];
  for (const w of words) {
    if ((line + ' ' + w).length > 118) { commentLines.push(line); line = w; if (commentLines.length >= 3) break; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line && commentLines.length < 3) commentLines.push(line);
  for (li = 0; li < 3; li++) {
    const cy = commentTop - 12 - li * 12;
    hline(L + 6, R - 6, cy - 2, 0.5);
    if (commentLines[li]) text(commentLines[li], L + 8, cy, 7.5);
  }

  // ---- Footer bar, as printed on the pads ----
  page.drawRectangle({ x: L, y: boxBottom, width: R - L, height: 14, borderColor: INK, borderWidth: 1 });
  text('White Copy- Office', L + 20, boxBottom + 4, 7.5);
  text('Yellow Copy- Job Supervisor/Foreman', 280, boxBottom + 4, 7.5);

  return doc.save();
}

// A signature PNG drawn sitting on its fill-in line. Missing or unreadable
// just leaves the line — a PDF that fails over a signature fetch helps
// nobody.
async function drawSigOnLine(
  db: SupabaseClient,
  doc: PDFDocument,
  page: PDFPage,
  sigPath: string | null,
  x: number,
  lineY: number,
  maxW: number,
  maxH: number,
) {
  if (!sigPath) return;
  try {
    const { data } = await db.storage.from(BUCKET).download(sigPath);
    if (!data) return;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const img: PDFImage = await doc.embedPng(bytes);
    const s = Math.min(maxW / img.width, maxH / img.height);
    page.drawImage(img, { x: x + 4, y: lineY - 2, width: img.width * s, height: img.height * s });
  } catch { /* line stays blank */ }
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

    const pdfPath = `work-orders/${workOrderId}/haul-ticket.pdf`;
    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(pdfPath, bytes as unknown as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
    if (upErr) return null;
    await db.from('work_orders').update({ ticket_pdf_path: pdfPath }).eq('id', workOrderId);
    return { path: pdfPath, bytes };
  } catch {
    return null;
  }
}
