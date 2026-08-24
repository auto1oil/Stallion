// Connector to the fuel/vehicle app's read-only "list receipts" API. That app
// owns receipt intake (drivers upload there); Auto 1 only reads them, so nobody
// uploads a receipt twice. Configured by two env vars:
//   RECEIPTS_API_URL  — the other app's endpoint, e.g.
//                       https://your-fuel-app.vercel.app/api/receipts
//   RECEIPTS_API_KEY  — shared secret, sent as a Bearer token
// The exact contract the other app implements is in docs/receipts-api-spec.md.

export type ExternalReceipt = {
  id: string;
  driver: string | null;        // driver name/identifier from the other app
  driverEmail: string | null;   // preferred join key when present
  date: string | null;          // ISO yyyy-mm-dd
  amount: number | null;
  gallons: number | null;       // fuel receipts only
  fileUrl: string | null;       // link/signed URL to the image or PDF
};

export function receiptsConfigured(): boolean {
  return !!(process.env.RECEIPTS_API_URL && process.env.RECEIPTS_API_KEY);
}

// Push (write) side: when a driver submits a receipt in Auto 1, forward it to
// OneGloveBox so it lands there automatically (no manual re-entry). Needs the
// OGB ingest endpoint URL; reuses the same shared key as the read side.
export function receiptsPushConfigured(): boolean {
  return !!(process.env.RECEIPTS_INGEST_URL && process.env.RECEIPTS_API_KEY);
}

export type ReceiptPush = {
  driver: string | null;        // driver's full name
  driverEmail: string | null;
  vendor: string | null;
  amount: number | null;
  date: string | null;          // yyyy-mm-dd (charge date)
  note: string | null;          // driver explanation
  fileUrl: string | null;       // fetchable URL to the photo (signed, ~1h)
  externalRef: string;          // Auto 1 charge id, for idempotency/dedupe
};

// POST a receipt to the OneGloveBox ingest endpoint. Returns the OGB receipt id
// on success. Never throws — returns {ok:false} so the caller can fall back to
// the manual "Submitted" queue.
export async function pushReceiptToOgb(r: ReceiptPush): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!receiptsPushConfigured()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(process.env.RECEIPTS_INGEST_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RECEIPTS_API_KEY!}` },
      body: JSON.stringify({
        driver: r.driver, driver_email: r.driverEmail, vendor: r.vendor,
        amount: r.amount, date: r.date, note: r.note,
        file_url: r.fileUrl, external_ref: r.externalRef,
      }),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `ingest ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const j = await res.json().catch(() => ({}));
    return { ok: true, id: j?.id != null ? String(j.id) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'push failed' };
  }
}

// Fetch receipts on/after `since` (yyyy-mm-dd). Returns [] when not configured
// so callers degrade gracefully instead of throwing.
export async function fetchExternalReceipts(since: string): Promise<ExternalReceipt[]> {
  if (!receiptsConfigured()) return [];
  const base = process.env.RECEIPTS_API_URL!;
  const url = `${base}${base.includes('?') ? '&' : '?'}since=${encodeURIComponent(since)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.RECEIPTS_API_KEY!}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`receipts API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.receipts;
  if (!Array.isArray(rows)) throw new Error('receipts API: expected { receipts: [...] }');
  return rows.map(normalizeReceipt);
}

// Accept a few reasonable field spellings so the other app's builder has some
// latitude in exactly what it returns.
function normalizeReceipt(r: Record<string, unknown>): ExternalReceipt {
  const s = (v: unknown) => (v == null ? null : String(v));
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const date = r.date ?? r.receipt_date ?? r.purchased_at ?? null;
  return {
    id: String(r.id ?? r.receipt_id ?? ''),
    driver: s(r.driver ?? r.driver_name ?? r.cardholder),
    driverEmail: s(r.driver_email ?? r.email),
    date: date ? String(date).slice(0, 10) : null,
    amount: num(r.amount ?? r.total ?? r.total_amount),
    gallons: num(r.gallons ?? r.qty ?? r.quantity),
    fileUrl: s(r.file_url ?? r.fileUrl ?? r.url ?? r.image_url),
  };
}
