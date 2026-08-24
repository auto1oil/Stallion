# OneGloveBox "receipt ingest" endpoint (for auto-push from Auto 1)

When a driver submits a receipt in the Auto 1 app, Auto 1 will POST it to a
OneGloveBox endpoint so it lands in OneGloveBox automatically — no manual
re-entry. OneGloveBox needs to build this one endpoint.

## Endpoint

```
POST  <your OneGloveBox ingest URL>
```

That URL goes into Auto 1's `RECEIPTS_INGEST_URL` env var. Until it's set, Auto 1
keeps the current manual flow (nothing breaks).

## Auth

Same shared secret as the read API (the `RECEIPTS_API_KEY` we already exchanged),
sent as a Bearer token:

```
Authorization: Bearer <shared secret>
Content-Type: application/json
```

Reject anything without the correct token with `401`.

## Request body (JSON)

```json
{
  "driver": "Jay Mills",                 // driver's full name (match to your user)
  "driver_email": "jay@example.com",     // may be null; name is the reliable key
  "vendor": "Autozone",                  // who was paid (driver-entered, required)
  "amount": 8.57,                        // charge amount (number, may be null)
  "date": "2026-08-10",                  // charge date, yyyy-mm-dd
  "note": "Oil filter for truck 12",     // driver explanation (required)
  "file_url": "https://…signed-url…",    // fetch the photo from here within ~1 hour
  "external_ref": "b1c2…"                // Auto 1 charge id — use for idempotency
}
```

- **`file_url`** is a temporary signed link to the receipt image/PDF. Download and
  store it on your side promptly (valid ~1 hour). It may be an image (jpg/png/heic)
  or a PDF.
- **`external_ref`** is stable per charge. If you get the same `external_ref`
  twice, treat it as the same receipt (update, don't duplicate) — Auto 1 may retry.

## Response

- **Success:** `200` (or `201`) with JSON `{ "id": "<your receipt id>" }`.
  Auto 1 stores that id and marks the charge **matched**.
- **Failure:** any non-2xx. Auto 1 leaves the receipt in its manual "Submitted"
  queue so an admin can still enter it by hand — so a temporary outage never
  loses a receipt.

## That's it

One authenticated POST that accepts the JSON above, downloads `file_url`, files
the receipt under the named driver, and returns an id. Send us the URL and we'll
set `RECEIPTS_INGEST_URL` — auto-push turns on with no further changes.
