// ============================================================================
// AI bill extraction — turn a vendor-invoice PDF/image into structured fields.
// ============================================================================
// Calls the Anthropic API directly (no SDK dependency) with the attachment as a
// document/image block and asks for strict JSON. The result prefills the
// vendor-bills review row; an admin still confirms before anything is pushed to
// QuickBooks, so a wrong field is corrected, never auto-posted.
//
// Required env var: ANTHROPIC_API_KEY

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

export type ParsedBill = {
  vendor_name: string | null;
  invoice_number: string | null;
  bill_date: string | null;   // YYYY-MM-DD
  due_date: string | null;    // YYYY-MM-DD
  total_amount: number | null;
  memo: string | null;
  line_items: { description: string; qty: number | null; unit_cost: number | null; amount: number }[];
};

const PROMPT = `You are extracting data from a vendor invoice/bill for accounts payable.
Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
- vendor_name: the company that issued the invoice (the payee/seller), or null
- invoice_number: the invoice or document number, or null
- bill_date: the invoice date as "YYYY-MM-DD", or null
- due_date: the payment due date as "YYYY-MM-DD", or null
- total_amount: the grand total to pay as a number (no currency symbol), or null
- memo: a short description (e.g. "Fuel delivery 5/12") or null
- line_items: an array of one object per charge line, with keys:
    "description": string (the product/charge as printed on the bill),
    "qty": number or null (quantity — gallons, cases, units),
    "unit_cost": number or null (price per unit/gallon),
    "amount": number (the line total = qty x unit_cost).
  INCLUDE every row in the line-item table that has a quantity — that means
  the product line AND each per-unit fee/tax line (e.g. "FED LUST TAX",
  "UTAH E.A.F. FEE", "FEDERAL SUPERFUND FEE"), since taxes are tracked like
  products here. Even zero-dollar fee lines should be included.
  OMIT the summary rows only: anything labeled "Sub Total", "Fuel Sub Total",
  "Subtotal", "Sales Tax", or "Total".
Dates must be ISO YYYY-MM-DD. Numbers must be raw JSON numbers with NO currency
symbols and NO thousands separators — write 1234.56 (never "$1,234.56" or 1,234.56).
If a field is not present, use null. Output ONLY valid JSON.`;

export async function parseBillDocument(
  base64: string,
  contentType: string,
): Promise<ParsedBill> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — AI bill parsing is not configured.');

  const ct = contentType.toLowerCase();
  // Detect a PDF by its content-type OR its bytes — vendors often send PDFs with
  // a generic "application/octet-stream" type, and sending those as an image
  // makes Anthropic 400 with "Could not process image". Base64 of a PDF starts
  // with "JVBER" (the "%PDF" header).
  const isPdf = ct === 'application/pdf' || ct.includes('pdf') || base64.startsWith('JVBER');
  const imageType = ct.startsWith('image/') && ct !== 'image/heic' && ct !== 'image/heif' ? ct : 'image/jpeg';
  const docBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: imageType, data: base64 } };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: [docBlock, { type: 'text', text: PROMPT }] }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic parse failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('').trim();
  return coerce(extractJson(text));
}

// Models sometimes wrap JSON in ```json fences despite instructions — strip to
// the first {...} block before parsing. If that fails, retry after stripping
// thousands-separator commas inside numbers (the common cause: "1,234.56" in a
// number position, which is invalid JSON).
function extractJson(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  const slice = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  try {
    return JSON.parse(slice);
  } catch {
    // Remove commas that sit between digits (1,234 → 1234). Run twice for
    // millions (1,234,567). Cosmetic if it touches a number inside a string.
    const repaired = slice.replace(/(\d),(?=\d{3}(\D|$))/g, '$1').replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
    return JSON.parse(repaired);
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function coerce(raw: unknown): ParsedBill {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(o.line_items) ? o.line_items : [];
  return {
    vendor_name: str(o.vendor_name),
    invoice_number: str(o.invoice_number),
    bill_date: str(o.bill_date),
    due_date: str(o.due_date),
    total_amount: num(o.total_amount),
    memo: str(o.memo),
    line_items: items
      .map((l) => {
        const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
        return {
          description: str(li.description) || '',
          qty: num(li.qty),
          unit_cost: num(li.unit_cost),
          amount: num(li.amount) ?? 0,
        };
      })
      .filter((l) => l.description || l.amount),
  };
}
