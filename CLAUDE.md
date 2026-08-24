# Auto 1 Oil Dispatch — working agreement

## ⚠️ Auto-merge every change — DO NOT ask (non-negotiable)

The user wants every change shipped the moment it's made. After ANY code
change, without asking and without waiting for approval:

1. Commit + push to the one dev branch `claude/ui-layout-adjustments-IFq5l`.
2. Open a PR to `main` and **merge it immediately** (squash).

Do **not** ask "want me to merge?" / "should I deploy?" — just do it. There is
**one branch** (`claude/ui-layout-adjustments-IFq5l`); never create new feature
branches. Only pause to confirm if a merge would (a) deploy clearly unrelated,
unfinished work the user didn't ask for, or (b) require SQL the user must run by
hand — in those two cases, flag it, otherwise merge silently.

## ⚠️ Ship changes BOTH ways, every time (non-negotiable)

A feature is only "done" when **both** halves are delivered:

1. **Code** — committed, pushed, PR merged to `main` (auto-deploys via Vercel).
2. **Database** — any schema/policy/function/seed change applied in Supabase.

The assistant **cannot run SQL** on the production database. Only the user can,
in the Supabase SQL editor. So for any change that touches the DB:

- Put the schema change in `supabase-setup.sql` (idempotent: `if not exists`,
  `create or replace`, `drop policy if exists`). The whole file is safe to
  re-run — re-running it applies every accumulated schema change at once.
- **Also** paste the exact SQL into chat as a copy-paste block (mobile-friendly:
  no `<`/`>` tokens that the editor mangles, no `alias.id` forms).
- For data loads (price/inventory seeds), generate a file AND keep it minimal.

### Always verify the DB side — don't assume it ran
After giving SQL, give the user a one-line **verification query** and ask them
to paste the result. Do not mark the task done until the count/return proves it.
Example: `select count(*) filter (where retail_price is not null) from public.inventory_items;`

### When the user says "it didn't show up / asked X times"
First check, in order:
1. Open PRs (`list_pull_requests`) — anything unmerged?
2. Is the code actually on `main`? (grep the column/feature)
3. **Is the SQL applied?** Give a verification query. This is usually the gap.
Report which of the three it is before sending another fix.

## Repo facts
- `supabase-setup.sql` — canonical idempotent schema. Re-runnable in full.
- Dev branch: `claude/ui-layout-adjustments-IFq5l`. Merge to `main` to deploy.
- Pricing/inventory pages live under `/admin` (admin-gated). Cost = admins only.
- After any merge, the user must hard-refresh / reopen the PWA (cached bundle).

## Fuel taxes on gasoline invoices (known gotcha)
Gasoline lines use abbreviated QB names like `GAL:GAS 85 OCT UL 10% ETHANOL`
and `GAS 91 OCT UL 10% ETHANOL` (not the words "gasoline/unleaded/octane").
Fuel-name detection is centralized in `lib/fuel-detect.ts` (`GASOLINE_RE`) —
every server tax/commission path must use it, never a local
`/(gasoline|unleaded|octane)/`.

When editing/adjusting a fuel invoice, `edit-invoice`'s `withFuelTaxes()`
**strips** existing fuel-tax lines then **re-adds** them by looking up the exact
names in `FUEL_TAX_ITEM_NAMES` (lib/quickbooks.ts). So if the user reports "I
added gas taxes in QB and the app deleted them," check IN ORDER:
1. Did the fix actually deploy before the invoice was re-saved? (deploy timing)
2. Is the gasoline line recognized? (`GASOLINE_RE` — abbreviations included)
3. **Do the QB gas tax item names EXACTLY match `FUEL_TAX_ITEM_NAMES['85-Octane']`?**
   If a name differs, `findItemsByNames` can't find it → the line gets stripped
   but never re-added (looks like a deletion). Fix by matching the constant to
   the real QB item names, or vice versa. Current expected gas tax items:
   `Fed Excise Tax - GAS 1`, `Fed Hazard Subst Fee GAS 2`,
   `UT Envir/Cleanup Fee GAS 3`, `Ut. State Excise Tax - Gas 4` (85 & 91 share).

## Inventory data — always include ALL of these
Any inventory seed/import/sync must carry, for every item: **cost, retail
(sales) price, current quantity on hand (qty_on_hand), exact QuickBooks
description, SKU, and packaging.** Quantity on hand is non-negotiable — include
it in every generated seed and keep it refreshed via the QuickBooks stock sync
(/api/quickbooks/sync-inventory + nightly cron). Source columns from the QB
Product/Service export: Sales Price→retail, Purchase Cost→cost,
Quantity On Hand→qty_on_hand.
