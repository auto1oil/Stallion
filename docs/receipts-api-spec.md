# "List Receipts" API — spec for the fuel/vehicle app

Auto 1 Dispatch reconciles company credit-card charges (pulled from the bank via
Plaid) against the receipts your drivers already upload in **the fuel/vehicle
app**. So drivers keep uploading receipts in **one place** (your app), and Auto 1
just *reads* them and matches each one to a charge. Nobody uploads twice.

To make that work, the fuel/vehicle app needs to expose **one read-only
endpoint** that lists receipts. That's the entire integration — Auto 1 never
writes anything back.

Both apps live in the same Supabase/Vercel/GitHub account but are otherwise
separate. This endpoint is the only thing that connects them.

---

## The endpoint

```
GET /api/receipts?since=YYYY-MM-DD
```

- **Auth:** require an `Authorization: Bearer <RECEIPTS_API_KEY>` header. Reject
  anything else with `401`. Pick a long random string for the key; you'll give
  the same value to Auto 1 (it stores it as `RECEIPTS_API_KEY`).
- **`since` query param:** ISO date (`2026-08-01`). Return every receipt whose
  date is on/after `since`. Auto 1 asks for ~30 days at a time. If you want to
  ignore it at first and just return the last 60–90 days, that's fine.
- **Runtime:** read-only. No side effects.

### Response shape

Return JSON — either a bare array or `{ "receipts": [ ... ] }` (Auto 1 accepts
both):

```json
{
  "receipts": [
    {
      "id": "rcpt_1042",
      "driver": "Jose Martinez",
      "driver_email": "jose@checkerflag.biz",
      "date": "2026-08-08",
      "amount": 84.13,
      "gallons": 22.4,
      "file_url": "https://…/receipts/rcpt_1042.jpg"
    }
  ]
}
```

### Fields

| Field          | Type            | Required | Notes                                                                 |
|----------------|-----------------|----------|-----------------------------------------------------------------------|
| `id`           | string          | ✅       | Stable unique id of the receipt in your app. Used to dedupe matches.  |
| `date`         | string (ISO)    | ✅       | Purchase date, `YYYY-MM-DD`. This + `amount` is how matching works.   |
| `amount`       | number          | ✅       | Total on the receipt, in dollars (e.g. `84.13`).                      |
| `driver`       | string          | ▲        | Driver name. Helps confirm the match / attribute the charge.          |
| `driver_email` | string          | ▲        | Even better than name — a clean key to line up drivers across apps.   |
| `gallons`      | number \| null  | ▲        | Fuel receipts only. Not required, but tightens fuel matching later.   |
| `file_url`     | string          | ✅       | A link Auto 1 can open to view the receipt image/PDF.                 |

✅ = required, ▲ = strongly preferred (include if you have it).

**About `file_url`:** it must be openable by an admin clicking it in Auto 1. Two
options:
1. A **long-lived / signed URL** to the file in your Supabase Storage
   (e.g. a signed URL with a long expiry, or a public bucket URL).
2. A short-lived signed URL is fine too — Auto 1 opens it right after fetching.

Field spelling is flexible — Auto 1 also accepts `receipt_id`, `total`,
`driver_name`, `image_url`, `url`, etc. — but the names above are the clean set.

---

## Minimal implementation sketch (Next.js, same stack as Auto 1)

```ts
// app/api/receipts/route.ts  (in the FUEL/VEHICLE app)
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // 1) auth
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.RECEIPTS_API_KEY}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2) since filter
  const since = new URL(req.url).searchParams.get('since') ?? '2026-01-01';

  // 3) read receipts (service-role key — server-only)
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await db
    .from('receipts')                    // <-- your receipts table
    .select('id, driver_name, driver_email, purchased_at, amount, gallons, file_path')
    .gte('purchased_at', since)
    .order('purchased_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 4) shape + sign file URLs
  const receipts = await Promise.all((data ?? []).map(async (r) => {
    const { data: signed } = await db.storage
      .from('receipts')                  // <-- your receipts bucket
      .createSignedUrl(r.file_path, 60 * 10);
    return {
      id: r.id,
      driver: r.driver_name,
      driver_email: r.driver_email,
      date: r.purchased_at?.slice(0, 10),
      amount: r.amount,
      gallons: r.gallons,
      file_url: signed?.signedUrl ?? null,
    };
  }));

  return NextResponse.json({ receipts });
}
```

Adjust the table/column/bucket names to whatever the fuel app actually uses.

---

## What Auto 1 does with it

- Calls this endpoint on a schedule (nightly) and on demand from the **Card
  Charges** screen.
- Matches each receipt to a card charge by **amount + date (±2 days)**.
- A charge with no matching receipt is flagged **“missing receipt.”**
- `driver` / `driver_email` are used to attribute and confirm.

## Config handshake

Once the endpoint is live, Auto 1 needs two env vars (set in **Auto 1's** Vercel
project):

```
RECEIPTS_API_URL = https://<the-fuel-app-domain>/api/receipts
RECEIPTS_API_KEY = <the same secret the endpoint checks>
```

That's it — no shared database, no shared code. Just this one endpoint.
