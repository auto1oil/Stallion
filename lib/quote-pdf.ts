// Fill the Price Quote PDF (public/forms/price-quote.pdf) from quote data and
// return the flattened bytes. Runs in the browser (pdf-lib), same as the form
// filler — used to generate, share, download, and re-open saved quotes.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type QuoteLine = {
  desc?: string;
  cat?: string;
  pack?: string;
  unit?: string;
  price?: string;
};

export type QuoteData = {
  quote_number?: string;
  quote_date?: string;
  valid_thru?: string;
  customer_company?: string;
  customer_contact?: string;
  customer_address?: string;
  customer_phone_email?: string;
  sales_rep?: string;
  lines: QuoteLine[];
};

// One-line "Sales Rep" value: name + phone + email (skipping any that are blank).
export function repLine(name?: string | null, phone?: string | null, email?: string | null): string {
  return [name, phone, email].map((s) => (s || '').trim()).filter(Boolean).join('  ·  ');
}

export async function fillQuotePdf(data: QuoteData): Promise<Uint8Array> {
  const ab = await fetch('/forms/price-quote.pdf').then((r) => r.arrayBuffer());
  const pdf = await PDFDocument.load(ab);
  const form = pdf.getForm();
  const set = (name: string, val?: string | null) => {
    if (val == null || val === '') return;
    try { form.getTextField(name).setText(String(val)); } catch { /* field not in PDF */ }
  };

  set('quote_number', data.quote_number);
  set('quote_date', data.quote_date);
  set('valid_thru', data.valid_thru);
  set('customer_company', data.customer_company);
  set('customer_contact', data.customer_contact);
  set('customer_address', data.customer_address);
  set('customer_phone_email', data.customer_phone_email);
  set('sales_rep', data.sales_rep);
  // The Sales Rep line carries name + phone + email, so shrink it to fit the field.
  try { form.getTextField('sales_rep').setFontSize(7); } catch { /* field not in PDF */ }

  // Make sure the template's product form fields are empty so their (sample)
  // values don't render under the rows we draw below.
  for (let n = 1; n <= 10; n++) {
    for (const sfx of ['desc', 'cat', 'pack', 'unit', 'price']) {
      try { form.getTextField(`product_${n}_${sfx}`).setText(''); } catch { /* field not in PDF */ }
    }
  }

  // Flatten the header/customer fields first. Product rows are then DRAWN as
  // text (not form fields) so all 10 rows render uniformly on the 10-row grid.
  // Order matters: drawText after flatten() persists; drawing before it gets
  // dropped when flatten rewrites the page content stream.
  form.flatten();

  const page = pdf.getPages()[0];
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const SIZE = 8;
  const TOP = 527.1, ROW_H = 13.8; // grid: row i band bottom = TOP - (i+1)*ROW_H
  const COLS: { key: keyof QuoteLine; x: number; w: number }[] = [
    { key: 'desc', x: 43, w: 169 },
    { key: 'cat', x: 227, w: 104 },
    { key: 'pack', x: 346, w: 97 },
    { key: 'unit', x: 458, w: 27 },
    { key: 'price', x: 497, w: 72 },
  ];
  const clean = (t: string) => t.replace(/[^\x20-\x7E]/g, '').trim();
  const fit = (t: string, maxW: number) => {
    let s = clean(t);
    if (!s || font.widthOfTextAtSize(s, SIZE) <= maxW) return s;
    while (s.length > 1 && font.widthOfTextAtSize(s + '...', SIZE) > maxW) s = s.slice(0, -1);
    return s + '...';
  };
  data.lines.slice(0, 10).forEach((l, i) => {
    const y = TOP - (i + 1) * ROW_H + 3.7; // baseline, ~centered in the band
    for (const col of COLS) {
      const text = fit(String(l[col.key] ?? ''), col.w);
      if (text) page.drawText(text, { x: col.x, y, size: SIZE, font, color: rgb(0.1, 0.1, 0.1) });
    }
  });

  return pdf.save();
}

// Share the filled PDF via the phone's native share sheet (Messages / Mail …),
// falling back to a download when Web Share with files isn't available. Returns
// true if it was shared (vs downloaded).
export async function shareOrDownloadPdf(bytes: Uint8Array, filename: string): Promise<boolean> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return true;
    } catch {
      // user cancelled or share failed → fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return false;
}
