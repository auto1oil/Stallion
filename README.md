# Stallion — Field Tickets

A field-ticket / work-order app for a hauling contractor. Crews fill out a
ticket on the job, the office audits and invoices it, the contractor signs off
on their crews' hours, and the funder approves funds — replacing the
email-the-ticket → key-it-into-a-spreadsheet → email-for-funding loop.

Built on Next.js (App Router) + Supabase (Postgres, RLS, Storage) + Vercel,
installable as a PWA, with QuickBooks Online for customer invoicing.

---

## The flow

```
crew fills ticket  →  office audits + approves  →  funder approves funds
   /tickets              /work-orders                  /funder
   photo of the          edits anything off,           per-job truck count,
   paper ticket,         invoices the customer         approve funds
   FSR signature         in QuickBooks

                    contractor signs off on their crews' hours
                              /contractor
```

A ticket moves `draft → submitted → office_approved → funds_approved →
invoiced` (or `rejected`, which sends it back to the crew with a reason).
Hours and dollars are always recomputed from the row — start/stop plus travel
and down time, times the rate (or tonnage × rate on a tonnage job) — never
typed in and trusted.

## Roles

| Role | Sees | Can |
| --- | --- | --- |
| `driver` | `/tickets` | Fill out, photograph and submit field tickets |
| `office` | `/work-orders` | Review, edit, approve, invoice in QuickBooks |
| `contractor` | `/contractor` | Their crews' tickets, hours, rates; sign off; upload short tickets |
| `funder` | `/funder` | Every order, truck count per job, approve funds |
| `admin` / `master_admin` | everything | Full access, users, settings |
| `mechanic` / `labor` | time clock | Clock in/out, tasks, reminders |

`customer` still exists as a role, but only as a directory record: customers are
who the office invoices against, synced from QuickBooks. Nobody signs in as one —
there is no customer-facing side. A customer login that does reach the app lands
on `/no-access`.

Approvals never go through the browser's own write path: every status move
posts to `/api/work-orders/[id]/approve`, which checks the caller's role and
writes only that role's approval columns with the service role. RLS decides
who can see a row; the route decides which columns they can touch.

---

## Setup

You need three free accounts: **GitHub**, **Supabase**, and **Vercel**, plus
an **Intuit developer** account for QuickBooks invoicing.

### 1 — Supabase

1. supabase.com → New project. Pick the region closest to your crews.
2. **SQL Editor → New query** → paste all of `supabase-setup.sql` → Run.
   It creates every table, policy, trigger, and the `invoices` and
   `work-tickets` storage buckets. The whole file is safe to re-run — it was
   checked against a clean PostgreSQL 16 database, twice through, with no
   errors. If bucket creation is blocked, create them by hand under
   **Storage** (both private, named `invoices` and `work-tickets`) and re-run.

   Verify it took:

   ```sql
   select count(*) from public.work_orders;   -- 0, and no error
   select policyname from pg_policies where tablename = 'work_orders';  -- 8 rows
   ```
3. **Settings → API** — copy the **Project URL** and the **anon public** key,
   and the **service_role** key (server-only; it never goes near the browser).

### 2 — Your first admin

**Authentication → Add user → Create new user**, tick *Auto Confirm User*,
then in the SQL editor:

```sql
update public.profiles
set role = 'master_admin', full_name = 'Your Name'
where email = 'you@example.com';
```

Everyone else you add from **Users** inside the app.

### 3 — Vercel

Import the repo, then set the environment variables from
`.env.local.example`:

| Variable | What it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server only) |
| `NEXT_PUBLIC_SITE_URL` | Your deployed URL, e.g. `https://stallion.vercel.app` |
| `CRON_SECRET` | Any long random string — guards the cron routes |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web-push keys (`npx web-push generate-vapid-keys`) |
| `VAPID_SUBJECT` | `mailto:` address for push |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | From your Intuit app |
| `QUICKBOOKS_REDIRECT_URI` | `<your URL>/api/quickbooks/callback` |
| `QUICKBOOKS_ENV` | `sandbox` or `production` |

### 4 — QuickBooks

Sign in as an admin → **Settings → QuickBooks → Connect**, then
**Work Orders → Setup** and pick the QuickBooks item every approved ticket
bills against (hours or tonnage × the ticket's rate post to that item). Add
your job rates on the same screen — the ticket form offers the matching rate
to the crew, and contractors see them on their Rates tab.

### 5 — Brand it

`public/brand/stallion-logo.svg` and `stallion-mark.svg` are placeholders —
drop in the real artwork under the same names. The colour palette lives in
`tailwind.config.js` (`brand` = buttons and headers, `accent` = the stripe).
The app name is in `app/layout.tsx` and `public/manifest.webmanifest`.

---

## Converting an existing Auto 1 Dispatch project

If you're pointing this at a Supabase project that already ran the old Auto 1
schema, run `migrations/001-drop-removed-features.sql` **after** deploying this
code. It drops the salesman, fuel, inventory, bills, card-charge, trucking and
customer-storefront tables, moves any remaining `salesman` users to `office`,
and widens the role check to include `contractor` and `funder`. On a fresh
project it is a no-op.

## Repo map

| Path | What's in it |
| --- | --- |
| `app/tickets` | The crew's screens |
| `app/work-orders` | The office's queue, ticket review, setup |
| `app/contractor` | Contractor work orders, approvals, rates |
| `app/funder` | Funder orders + approve funds |
| `app/api/work-orders` | Ticket CRUD, approvals, invoicing |
| `app/admin` | Dispatch board, customers, hours, users, PO log, QuickBooks |
| `lib/work-orders.ts` | Hour/amount math and the QuickBooks invoice routine |
| `lib/quickbooks*.ts` | QuickBooks OAuth, customers, invoices, PDFs |
| `supabase-setup.sql` | The canonical, re-runnable schema |
| `migrations/` | One-off migrations for existing projects |

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in your values
npm run dev
```

Before pushing: `npx tsc --noEmit && npm run build`.
