-- ==========================================================================
-- Stallion Field Tickets — Database Setup (canonical, idempotent)
-- ==========================================================================
-- Run this entire file in the Supabase SQL Editor when setting up a fresh
-- project. Safe to re-run on an existing project — uses `if not exists`,
-- `create or replace`, and `drop policy if exists` so it won't error out.
--
-- AFTER running this:
--   1. The `invoices` storage bucket is created below (private). If your
--      Supabase project blocks bucket creation via SQL, create it manually
--      in Storage → New bucket → name = "invoices", Public = unchecked.
--   2. Create your first admin user in Authentication → Add user, then run:
--        update public.profiles set role = 'master_admin', full_name = 'Your Name'
--        where email = 'you@example.com';
--   3. Add admin phone numbers (used for the end-of-day SMS summary) via:
--        update public.profiles set phone = '+18015551234'
--        where email = 'admin@example.com';
-- ==========================================================================

-- Function bodies in this file reference tables defined further down (and vice
-- versa), which is fine at runtime but fails Postgres' create-time body check.
-- Turn it off for this script so the file can be read top-to-bottom.
set check_function_bodies = off;


-- ==========================================================================
-- 1. Helper functions: is_admin(), has_role()
-- ==========================================================================
-- is_admin() returns true if the current authenticated user has admin OR
-- master_admin role. Used in nearly every RLS policy that gates admin-only
-- writes. has_role() is the same idea for any other set of roles, so policies
-- naming several roles stay readable.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin', 'master_admin')
  );
$$;

create or replace function public.has_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = any(roles)
  );
$$;
grant execute on function public.has_role(text[]) to authenticated;


-- ==========================================================================
-- 2. profiles — extends auth.users with role, name, phone
-- ==========================================================================
-- Roles:
--   customer      — default for public shop signups; sees /shop
--   driver        — field crew: fills out work tickets; sees /tickets
--   office        — reviews, approves and invoices tickets; sees /work-orders
--   contractor    — sees their crews' tickets + rates; sees /contractor
--   funder        — Auto 1: sees every order, approves funds; sees /funder
--   admin         — full access except hiring master_admins; sees /admin
--   master_admin  — can do everything including delete delivery log entries
--   mechanic / labor — hourly staff (time clock, tasks, reminders)
--
-- phone is used by the end-of-day SMS summary to figure out who to text
-- (all admins with a phone number on file).

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'customer'
    check (role in ('admin', 'driver', 'contractor', 'funder', 'master_admin', 'customer', 'office', 'mechanic', 'labor')),
  phone text,
  -- Optional contact email shown on quotes (falls back to the login email).
  contact_email text,
  must_change_password boolean default true,
  created_at timestamptz default now()
);
alter table public.profiles add column if not exists contact_email text;

-- Customer-specific columns are added piecemeal so the canonical setup stays
-- additive and idempotent on existing projects. `city` (added below) is used
-- alongside business_name to match customer accounts to their locations.
alter table public.profiles add column if not exists city text;
-- Customer-facing details carried on the profile itself. `business_name` is
-- what a customer typed at signup (the linked Business row is authoritative
-- once they're linked); `imported_from_qb_customer_id` marks a profile the
-- QuickBooks customer sync created; `qb_class` tags a staff member's invoice
-- lines so QuickBooks can report P&L by rep.
alter table public.profiles add column if not exists business_name text;
alter table public.profiles add column if not exists address text;
alter table public.profiles add column if not exists imported_from_qb_customer_id text;
alter table public.profiles add column if not exists qb_class text;
create index if not exists profiles_imported_qb_idx
  on public.profiles(imported_from_qb_customer_id)
  where imported_from_qb_customer_id is not null;

-- Allow the 'customer' role and make it the default for new profiles. This is
-- separate from the create-table above because that is skipped on existing
-- projects (the table already exists), so the constraint/default must be
-- applied here too. Idempotent — safe to re-run. Without this, the role CHECK
-- rejects 'customer' and the column default turns every shop signup into a
-- 'driver' (giving customers staff access and bouncing them to /driver).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'driver', 'contractor', 'funder', 'master_admin', 'customer', 'office', 'mechanic', 'labor'));
alter table public.profiles alter column role set default 'customer';

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  -- New auth signups are always customers. Staff roles (driver/office/admin)
  -- are never self-assignable: the admin "add user" API creates the auth user
  -- and then updates this row to the chosen staff role. Hardcoding 'customer'
  -- here keeps a public signup from provisioning itself staff access, and makes
  -- shop signups land in /shop instead of being bounced to /driver.
  insert into public.profiles (id, email, full_name, role, must_change_password)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'customer',
    true
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ==========================================================================
-- 3. orders — fuel/PCMO/shipping deliveries
-- ==========================================================================

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  customer text not null,
  type text not null check (type in ('Fuel', 'PCMO', 'DEF', 'Shipping')),
  driver_id uuid references public.profiles(id) on delete set null,
  driver_name text,
  truck text,
  invoice_number text,
  invoice_pdf_path text,
  signed_pdf_path text,
  delivered boolean not null default false,
  delivered_at timestamptz,
  delivered_by uuid references public.profiles(id) on delete set null,
  delivered_by_name text,
  delivery_note text,
  signer_name text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);
-- Allow the DEF dispatch type on existing installs (constraint predates it).
alter table public.orders drop constraint if exists orders_type_check;
alter table public.orders add constraint orders_type_check check (type in ('Fuel', 'PCMO', 'DEF', 'Shipping'));

-- Staff member credited on an order, so it shows on their own invoice list.
alter table public.orders add column if not exists sales_rep_id uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists sales_rep_name text;

create index if not exists orders_date_idx on public.orders(date desc);
create index if not exists orders_driver_idx on public.orders(driver_id);


-- ==========================================================================
-- 4. hours — driver/employee timesheet
-- ==========================================================================

create table if not exists public.hours (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.profiles(id) on delete cascade,
  employee_name text not null,
  date date not null,
  hours numeric(5, 2) not null check (hours >= 0 and hours <= 24),
  notes text,
  created_at timestamptz default now()
);

create index if not exists hours_date_idx on public.hours(date desc);
create index if not exists hours_employee_idx on public.hours(employee_id);

-- Time clock: one row per clock-in; clock_out_at is null while the employee is
-- still clocked in. Admins (the Time clock board) can clock anyone in/out;
-- employees can clock themselves. Completed sessions roll up into the Hours view.
create table if not exists public.time_clock (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.profiles(id) on delete cascade,
  clock_in_at  timestamptz not null default now(),
  clock_out_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists time_clock_employee_idx on public.time_clock(employee_id, clock_in_at desc);
create index if not exists time_clock_open_idx on public.time_clock(employee_id) where clock_out_at is null;
-- Device timezone (IANA, e.g. "America/Chicago") reported at each punch, so a
-- cross-zone shift (clocked in from Texas, out in Mountain) is visible on the
-- board. Durations are unaffected (they use the absolute instants). Re-runnable.
alter table public.time_clock add column if not exists clock_in_tz  text;
alter table public.time_clock add column if not exists clock_out_tz text;
alter table public.time_clock enable row level security;
grant select, insert, update on public.time_clock to authenticated;
drop policy if exists "time_clock admin all" on public.time_clock;
create policy "time_clock admin all" on public.time_clock for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "time_clock own" on public.time_clock;
create policy "time_clock own" on public.time_clock for all to authenticated
  using (employee_id = auth.uid()) with check (employee_id = auth.uid());
grant delete on public.time_clock to authenticated;  -- admins can remove a bogus session

-- Time-clock adjustment requests: an employee who forgot to clock in/out asks
-- for a correction; only an admin can approve it (which then edits/creates the
-- session). Employees see/create their own; admins see and act on all.
create table if not exists public.time_clock_requests (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.profiles(id) on delete cascade,
  target_date   date not null,
  requested_in  timestamptz,
  requested_out timestamptz,
  reason        text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note    text,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists tcr_status_idx on public.time_clock_requests(status, created_at desc);
create index if not exists tcr_employee_idx on public.time_clock_requests(employee_id, created_at desc);
alter table public.time_clock_requests enable row level security;
grant select, insert, update on public.time_clock_requests to authenticated;
drop policy if exists "tcr admin all" on public.time_clock_requests;
create policy "tcr admin all" on public.time_clock_requests for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "tcr own read" on public.time_clock_requests;
create policy "tcr own read" on public.time_clock_requests for select to authenticated
  using (employee_id = auth.uid());
drop policy if exists "tcr own insert" on public.time_clock_requests;
create policy "tcr own insert" on public.time_clock_requests for insert to authenticated
  with check (employee_id = auth.uid() and status = 'pending');

-- Geofenced time clock -------------------------------------------------------
-- Named work sites (shop, yard, warehouse…). A self clock-in is only allowed
-- within a site's radius, UNLESS the employee is flagged remote (out-of-state
-- drivers). Each clock-in/out records its coordinates + which site it matched.
alter table public.profiles add column if not exists remote_clock boolean not null default false;

create table if not exists public.work_sites (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  radius_m   integer not null default 150,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.work_sites enable row level security;
grant select, insert, update, delete on public.work_sites to authenticated;
drop policy if exists "work_sites read" on public.work_sites;
create policy "work_sites read" on public.work_sites for select to authenticated using (true);
drop policy if exists "work_sites admin write" on public.work_sites;
create policy "work_sites admin write" on public.work_sites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

alter table public.time_clock
  add column if not exists clock_in_lat       double precision,
  add column if not exists clock_in_lng       double precision,
  add column if not exists clock_in_site_id   uuid references public.work_sites(id) on delete set null,
  add column if not exists clock_out_lat      double precision,
  add column if not exists clock_out_lng      double precision,
  add column if not exists clock_out_site_id  uuid references public.work_sites(id) on delete set null;

-- Location breadcrumbs while on the clock ------------------------------------
-- One GPS sample sent by the employee's app WHILE they're clocked in and have
-- the app open in the foreground. Mobile browsers can't report a locked or
-- backgrounded phone, so this is a foreground-only trail: it powers the live
-- "where are they now" link and the after-the-fact route on the Time Clock
-- board, but it has gaps whenever the app isn't open.
create table if not exists public.time_clock_pings (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.time_clock(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  double precision,
  recorded_at timestamptz not null default now()
);
create index if not exists tcp_session_idx on public.time_clock_pings(session_id, recorded_at);
create index if not exists tcp_employee_recent_idx on public.time_clock_pings(employee_id, recorded_at desc);
alter table public.time_clock_pings enable row level security;
grant select, insert on public.time_clock_pings to authenticated;
drop policy if exists "tcp admin all" on public.time_clock_pings;
create policy "tcp admin all" on public.time_clock_pings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "tcp own insert" on public.time_clock_pings;
create policy "tcp own insert" on public.time_clock_pings for insert to authenticated
  with check (employee_id = auth.uid());
drop policy if exists "tcp own read" on public.time_clock_pings;
create policy "tcp own read" on public.time_clock_pings for select to authenticated
  using (employee_id = auth.uid());


-- ==========================================================================
-- 6. delivery_log — append-only audit log of deliveries
-- ==========================================================================
-- Populated automatically by the on_order_delivered trigger whenever an
-- order transitions from delivered=false to delivered=true. Insert-only
-- for normal users; only master_admin can delete.

create table if not exists public.delivery_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid,
  invoice_number text,
  customer text not null,
  driver_name text,
  signer_name text,
  delivered_by_id uuid,
  delivered_by_name text,
  delivered_at timestamptz not null default now(),
  created_at timestamptz default now()
);

create index if not exists delivery_log_delivered_at_idx
  on public.delivery_log(delivered_at desc);

create or replace function public.log_delivery()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.delivered = true and (old.delivered is null or old.delivered = false) then
    insert into public.delivery_log (
      order_id, invoice_number, customer, driver_name, signer_name,
      delivered_by_id, delivered_by_name, delivered_at
    ) values (
      new.id, new.invoice_number, new.customer, new.driver_name, new.signer_name,
      new.delivered_by, new.delivered_by_name, coalesce(new.delivered_at, now())
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_order_delivered on public.orders;
create trigger on_order_delivered
  after update on public.orders
  for each row execute function public.log_delivery();


-- ==========================================================================
-- 8. Table grants for the `authenticated` role
-- ==========================================================================
-- IMPORTANT: Supabase does NOT auto-grant CRUD on tables created via raw
-- SQL. Without these grants, RLS policies never run — Postgres rejects the
-- request first with "permission denied for table". The Supabase Studio UI
-- usually adds these for you when you create tables via the GUI, but
-- migrations like this one need to do it explicitly.

grant select, insert, update, delete on public.profiles        to authenticated;
grant select, insert, update, delete on public.orders          to authenticated;
grant select, insert, update, delete on public.hours           to authenticated;
grant select, insert, delete         on public.delivery_log    to authenticated;


-- ==========================================================================
-- 9. Row Level Security — enable on every table
-- ==========================================================================

alter table public.profiles        enable row level security;
alter table public.orders          enable row level security;
alter table public.hours           enable row level security;
alter table public.delivery_log    enable row level security;


-- ==========================================================================
-- 10. RLS Policies — drop-then-create so this file is idempotent
-- ==========================================================================

-- ---- profiles ----
drop policy if exists "auth_users_read_profiles"    on public.profiles;
drop policy if exists "users_update_own_profile"    on public.profiles;
drop policy if exists "admins_update_any_profile"   on public.profiles;

create policy "auth_users_read_profiles"  on public.profiles
  for select to authenticated using (true);
create policy "users_update_own_profile"  on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "admins_update_any_profile" on public.profiles
  for update to authenticated using (public.is_admin());

-- ---- orders ----
drop policy if exists "auth_users_view_orders"        on public.orders;
drop policy if exists "admins_insert_orders"          on public.orders;
drop policy if exists "admins_update_orders"          on public.orders;
drop policy if exists "admins_delete_orders"          on public.orders;
drop policy if exists "auth_users_update_for_delivery" on public.orders;

create policy "auth_users_view_orders"        on public.orders
  for select to authenticated using (true);
create policy "admins_insert_orders"          on public.orders
  for insert to authenticated with check (public.is_admin());
create policy "admins_update_orders"          on public.orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins_delete_orders"          on public.orders
  for delete to authenticated using (public.is_admin());
-- Drivers need to be able to mark orders delivered. This is broad but
-- column-level restrictions aren't worth the complexity for this app.
create policy "auth_users_update_for_delivery" on public.orders
  for update to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ---- hours ----
drop policy if exists "Admins view all hours"        on public.hours;
drop policy if exists "Drivers view own hours"       on public.hours;
drop policy if exists "Anyone signed in can insert hours" on public.hours;
drop policy if exists "Admins update any hours"      on public.hours;
drop policy if exists "Drivers update own hours"     on public.hours;
drop policy if exists "Admins delete hours"          on public.hours;
drop policy if exists "Drivers delete own hours"     on public.hours;

create policy "Admins view all hours"   on public.hours
  for select using (public.is_admin());
create policy "Drivers view own hours"  on public.hours
  for select using (employee_id = auth.uid());
create policy "Anyone signed in can insert hours" on public.hours
  for insert with check (auth.uid() is not null);
create policy "Admins update any hours" on public.hours
  for update using (public.is_admin());
create policy "Drivers update own hours" on public.hours
  for update using (employee_id = auth.uid());
create policy "Admins delete hours"     on public.hours
  for delete using (public.is_admin());
create policy "Drivers delete own hours" on public.hours
  for delete using (employee_id = auth.uid());

-- ---- delivery_log ----
drop policy if exists "auth_users_view_delivery_log"    on public.delivery_log;
drop policy if exists "auth_users_insert_delivery_log"  on public.delivery_log;
drop policy if exists "master_admins_delete_delivery_log" on public.delivery_log;

create policy "auth_users_view_delivery_log"   on public.delivery_log
  for select to authenticated using (true);
create policy "auth_users_insert_delivery_log" on public.delivery_log
  for insert to authenticated with check (auth.uid() is not null);
create policy "master_admins_delete_delivery_log" on public.delivery_log
  for delete to authenticated using (
    exists (select 1 from public.profiles
            where id = auth.uid() and role = 'master_admin')
  );



-- ==========================================================================
-- 11. Storage bucket: invoices (private)
-- ==========================================================================
-- Holds signed delivery invoice PDFs. Private so only signed-in users can
-- read them. If your Supabase project blocks bucket creation via SQL, do
-- this manually in Storage → New bucket (name "invoices", Public off).

insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

drop policy if exists "Signed-in users can read invoices"   on storage.objects;
drop policy if exists "Signed-in users can upload invoices" on storage.objects;
drop policy if exists "Signed-in users can update invoices" on storage.objects;
drop policy if exists "Admins can delete invoices"          on storage.objects;

create policy "Signed-in users can read invoices"
  on storage.objects for select
  using (bucket_id = 'invoices' and auth.uid() is not null);

create policy "Signed-in users can upload invoices"
  on storage.objects for insert
  with check (bucket_id = 'invoices' and auth.uid() is not null);

create policy "Signed-in users can update invoices"
  on storage.objects for update
  using (bucket_id = 'invoices' and auth.uid() is not null);

create policy "Admins can delete invoices"
  on storage.objects for delete
  using (bucket_id = 'invoices' and public.is_admin());


-- ==========================================================================
-- 12. Businesses + multi-user-per-business
-- ==========================================================================
-- A Business is a customer the office invoices against. Several profiles
-- (owner / manager / accountant) can share one business_id, so a customer's
-- contacts all resolve to the same QuickBooks customer record. The QuickBooks
-- customer sync keeps this table in step.

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  phone text,
  qb_customer_id text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create index if not exists businesses_qb_customer_id_idx on public.businesses(qb_customer_id);
create index if not exists businesses_name_idx on public.businesses(lower(name));

-- Activity / deactivation. A business is auto-deactivated once it hasn't ordered
-- in over nine months (nightly /api/cron/deactivate-customers). Inactive ones
-- render shaded everywhere (admin, office, driver). A new order auto-
-- reactivates; admins/master admins can reactivate manually (sets
-- reactivated_at, which grants a fresh nine-month grace). last_activity_date is
-- the most recent order/invoice date, cached for display + the shading logic.
alter table public.businesses add column if not exists active boolean not null default true;
alter table public.businesses add column if not exists reactivated_at timestamptz;
alter table public.businesses add column if not exists last_activity_date date;
-- When true, an admin set this business's name by hand (e.g. "PartsCo" with
-- Ted as the contact) and the QuickBooks customer sync must NOT overwrite it
-- with the QB customer name. QB still drives names for every unlocked business.
alter table public.businesses add column if not exists name_locked boolean not null default false;

-- Location grouping: a business that is a QuickBooks sub-customer (one of a
-- company's delivery locations) points at its parent business here, so the app
-- can group all of a customer's locations under one heading. qb_parent_customer_id
-- records the parent's QB id so the sync can (re)resolve the link.
alter table public.businesses add column if not exists parent_business_id uuid
  references public.businesses(id) on delete set null;
alter table public.businesses add column if not exists qb_parent_customer_id text;
create index if not exists businesses_parent_idx on public.businesses(parent_business_id);

-- QB customer ids merged away as duplicates of this business. The customer sync
-- skips these so a company entered twice in QuickBooks never re-appears after an
-- admin merges it (see /api/admin/merge-customers + /api/quickbooks/sync-customers).
alter table public.businesses
  add column if not exists merged_qb_customer_ids text[] not null default '{}';

alter table public.profiles add column if not exists business_id uuid
  references public.businesses(id) on delete set null;
alter table public.profiles add column if not exists is_business_owner boolean
  not null default false;
create index if not exists profiles_business_id_idx on public.profiles(business_id);

alter table public.businesses enable row level security;

drop policy if exists businesses_admin_all       on public.businesses;
drop policy if exists businesses_salesman_read   on public.businesses;
drop policy if exists businesses_staff_read      on public.businesses;
drop policy if exists businesses_member_read     on public.businesses;
drop policy if exists businesses_customer_insert on public.businesses;
drop policy if exists businesses_owner_update    on public.businesses;

create policy businesses_admin_all on public.businesses
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','master_admin')))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','master_admin')));

-- Staff read the customer directory: the crew picks the customer on a field
-- ticket, and office/contractors/funders review and invoice against it.
create policy businesses_staff_read on public.businesses
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid()
                   and p.role in ('office','driver','mechanic','contractor','funder')));

create policy businesses_member_read on public.businesses
  for select to authenticated
  using (id = (select business_id from public.profiles where id = auth.uid()));

create policy businesses_customer_insert on public.businesses
  for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'customer'));

create policy businesses_owner_update on public.businesses
  for update to authenticated
  using (id = (select business_id from public.profiles where id = auth.uid() and is_business_owner = true))
  with check (id = (select business_id from public.profiles where id = auth.uid() and is_business_owner = true));

-- One-time backfill: existing customer profile → its own Business + owner.
-- Skips any profile that's already linked, so this is safe to re-run.
do $$
declare
  prof record;
  new_biz_id uuid;
begin
  for prof in
    select id, full_name, email, business_name, phone, address, imported_from_qb_customer_id
    from public.profiles
    where role = 'customer' and business_id is null
  loop
    insert into public.businesses (name, address, phone, qb_customer_id, created_at)
    values (
      coalesce(
        nullif(trim(prof.business_name), ''),
        nullif(trim(prof.full_name), ''),
        prof.email
      ),
      prof.address,
      prof.phone,
      prof.imported_from_qb_customer_id,
      now()
    )
    returning id into new_biz_id;
    update public.profiles
      set business_id = new_biz_id, is_business_owner = true
      where id = prof.id;
  end loop;
end $$;

-- Table-level GRANTs for everything created in this section. PostgREST
-- (Supabase) runs as the authenticated/anon roles; without these grants
-- the API returns "permission denied for table ..." before RLS is even
-- evaluated. The Supabase dashboard adds these automatically when you
-- create tables in the UI, but SQL-applied migrations need them explicit.
grant select, insert, update, delete on public.businesses              to authenticated;

-- ==========================================================================
-- 40. Tables the canonical file was missing
-- ==========================================================================
-- These nine tables are used all over the app but were never written into the
-- setup file — they had been created by hand in the original project, so a
-- genuinely fresh Supabase project came up broken (every read against them
-- errored). Reconstructed here from the columns the code actually reads and
-- writes, so this file really does stand a new project up on its own.
--
-- `notifications` in particular backs the work-order flow: the push trigger in
-- section 19 fires off a row inserted here.

-- ---- QuickBooks connection (single row, id = 1) --------------------------
create table if not exists public.quickbooks_connection (
  id                       int primary key default 1 check (id = 1),
  realm_id                 text,
  access_token             text,
  access_token_expires_at  timestamptz,
  refresh_token            text,
  environment              text not null default 'sandbox'
                             check (environment in ('sandbox', 'production')),
  connected_by             uuid references public.profiles(id) on delete set null,
  connected_at             timestamptz,
  updated_at               timestamptz not null default now()
);
grant select, insert, update, delete on public.quickbooks_connection to authenticated;
alter table public.quickbooks_connection enable row level security;
-- Tokens are admin-only. Server routes reach them with the service-role key.
drop policy if exists "Admins manage quickbooks_connection" on public.quickbooks_connection;
create policy "Admins manage quickbooks_connection" on public.quickbooks_connection
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- Notifications (the bell + web push) ---------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind         text not null,
  title        text not null,
  body         text,
  link         text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_recipient_idx
  on public.notifications(recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications(recipient_id) where read_at is null;
grant select, insert, update, delete on public.notifications to authenticated;
alter table public.notifications enable row level security;

drop policy if exists "Read own notifications"   on public.notifications;
drop policy if exists "Update own notifications" on public.notifications;
drop policy if exists "Delete own notifications" on public.notifications;
drop policy if exists "Staff create notifications" on public.notifications;
create policy "Read own notifications" on public.notifications
  for select to authenticated using (recipient_id = auth.uid());
create policy "Update own notifications" on public.notifications
  for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
create policy "Delete own notifications" on public.notifications
  for delete to authenticated using (recipient_id = auth.uid() or public.is_admin());
-- Any signed-in staff member can notify someone else (submitting a ticket
-- notifies the office, approving it notifies the crew).
create policy "Staff create notifications" on public.notifications
  for insert to authenticated
  with check (
    public.is_admin()
    or public.has_role(array['office','driver','mechanic','contractor','funder','labor'])
  );

-- ---- Customer documents (profile sheet / TC-721 / W-9) -------------------
create table if not exists public.customer_documents (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references public.profiles(id) on delete cascade,
  doc_type         text not null check (doc_type in ('profile_sheet','tax_exempt','fein','w9','filled_form')),
  file_path        text not null,
  file_name        text,
  file_size_bytes  bigint,
  mime_type        text,
  uploaded_at      timestamptz not null default now()
);
-- One current document per type per customer — the upload path upserts on this.
create unique index if not exists customer_documents_customer_type_idx
  on public.customer_documents(customer_id, doc_type);
grant select, insert, update, delete on public.customer_documents to authenticated;
alter table public.customer_documents enable row level security;

-- ---- QuickBooks mappings --------------------------------------------------
create table if not exists public.customer_qb_mapping (
  profile_id        uuid primary key references public.profiles(id) on delete cascade,
  qb_customer_id    text not null,
  qb_customer_name  text,
  updated_at        timestamptz not null default now()
);
grant select, insert, update, delete on public.customer_qb_mapping to authenticated;
alter table public.customer_qb_mapping enable row level security;
drop policy if exists "Staff manage customer_qb_mapping" on public.customer_qb_mapping;
create policy "Staff manage customer_qb_mapping" on public.customer_qb_mapping
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));



-- ==========================================================================
-- 13. Dispatch order tracking
-- ==========================================================================
-- Customer-facing status on the dispatch `orders` table so the customer can
-- see "in progress" / "out for delivery" / "delivered with timestamp".
alter table public.orders
  add column if not exists status text not null default 'warehouse'
    check (status in ('warehouse', 'out_for_delivery', 'delivered'));
alter table public.orders
  add column if not exists loaded_at timestamptz,
  add column if not exists loaded_by uuid references public.profiles(id) on delete set null,
  add column if not exists loaded_by_name text;
-- Carry the name of the person who placed the order (the customer-order
-- submitter — a customer, or a sales rep ordering on their behalf) onto the
-- dispatch row, so "who put this order in" stays visible through every stage
-- (warehouse → out for delivery → delivered) in case there are questions.
alter table public.orders
  add column if not exists placed_by uuid references public.profiles(id) on delete set null,
  add column if not exists placed_by_name text;
-- How the order entered: 'placed' (came from a customer/rep order in the app)
-- vs 'uploaded' (an admin keyed in an invoice via Upload invoice). Drives the
-- "Order placed by" vs "Order uploaded by" label. Null = legacy/unknown.
alter table public.orders
  add column if not exists entry_method text check (entry_method in ('placed', 'uploaded'));
create index if not exists orders_status_idx on public.orders(status);

-- Who last adjusted this order's invoice (shown on the card like "Placed by").
alter table public.orders
  add column if not exists invoice_edited_by_name text,
  add column if not exists invoice_edited_at timestamptz;
update public.orders set status = 'delivered' where delivered = true  and status <> 'delivered';
update public.orders set status = 'warehouse' where delivered = false and status <> 'warehouse' and status <> 'out_for_delivery';

-- Going forward, any new public table created by a SQL migration should
-- be reachable by the authenticated role by default.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- Territory by county — replaces the older per-city scheme. Any user
-- (office, admin, master_admin) can have a list of approved counties;
-- customers carry their own county so the match is a direct array check.
-- Default = all four counties so a brand-new user shows up everywhere
-- until admin toggles a county off.
alter table public.profiles
  add column if not exists territory_counties text[] not null
    default ARRAY['Utah County','Salt Lake County','Davis County','Weber County']::text[],
  add column if not exists county text;
alter table public.profiles
  alter column territory_counties
  set default ARRAY['Utah County','Salt Lake County','Davis County','Weber County']::text[];
create index if not exists profiles_county_idx on public.profiles(county);

-- Backfill: any non-customer user with an empty territory gets all
-- four counties so they're immediately requestable everywhere.
update public.profiles
  set territory_counties = ARRAY['Utah County','Salt Lake County','Davis County','Weber County']
  where role <> 'customer'
    and (territory_counties is null or array_length(territory_counties, 1) is null);

create or replace function public.salesmen_for_county(county_in text)
returns table (id uuid, full_name text, email text, territory_counties text[])
language sql security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.territory_counties
  from public.profiles p
  where p.role in ('office','admin','master_admin')
    and (
      coalesce(array_length(p.territory_counties, 1), 0) = 0
      or county_in is null
      or county_in = any(p.territory_counties)
    )
  order by p.full_name;
$$;
grant execute on function public.salesmen_for_county(text) to authenticated;

-- Cached QB customer payment method + sales term (refreshed by
-- /api/quickbooks/sync-balances). Used to render the Terms badge on
-- /admin/customers.
alter table public.businesses
  add column if not exists qb_payment_method text,
  add column if not exists qb_payment_terms text;


-- ==========================================================================
-- 15. orders.billed — office "this invoice has been billed" flag
-- ==========================================================================
-- A checkbox on the Delivered cards in Dispatch lets office staff mark an
-- order's invoice as billed. The flag persists on the order row. Admins can
-- already UPDATE orders (admins_update_orders), so no new policy is needed.

alter table public.orders
  add column if not exists billed boolean not null default false;


-- ==========================================================================
-- 16. Notification preferences — per-staff toggles for the Settings tab
-- ==========================================================================
-- profiles.notify_on_new_order already exists. Add the remaining categories
-- the Settings tab exposes. Defaults on so staff are opted in until they
-- choose otherwise.

alter table public.profiles
  add column if not exists notify_on_new_order     boolean not null default true,
  add column if not exists notify_on_order_status  boolean not null default true,
  add column if not exists notify_on_new_customer  boolean not null default true,
  add column if not exists notify_on_work_order    boolean not null default true,
  add column if not exists notify_on_task          boolean not null default true;


-- ==========================================================================
-- 17. push_subscriptions — Web Push endpoints, one per device per user
-- ==========================================================================
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id);

grant select, insert, update, delete on public.push_subscriptions to authenticated;
alter table public.push_subscriptions enable row level security;

drop policy if exists "Users manage their own push subscriptions" on public.push_subscriptions;
create policy "Users manage their own push subscriptions"
  on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ==========================================================================
-- 18. tasks — admin-assigned to-dos, one row per assignee
-- ==========================================================================
-- "Send to all / pick multiple" inserts one row per chosen employee, sharing
-- a batch_id so the admin view can group them back together and show
-- per-employee completion.

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null default gen_random_uuid(),
  title           text not null,
  details         text,
  due_date        date,
  assignee_id     uuid not null references public.profiles(id) on delete cascade,
  assignee_name   text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_name text,
  completed_at    timestamptz,
  completed_by    uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);
create index if not exists tasks_batch_idx     on public.tasks(batch_id);
create index if not exists tasks_created_idx   on public.tasks(created_at desc);

grant select, insert, update, delete on public.tasks to authenticated;
alter table public.tasks enable row level security;

drop policy if exists "Assignees and admins view tasks"   on public.tasks;
drop policy if exists "Admins create tasks"                on public.tasks;
drop policy if exists "Assignees and admins update tasks"  on public.tasks;
drop policy if exists "Admins delete tasks"                on public.tasks;

-- Assignee sees their own; admins see everything.
create policy "Assignees and admins view tasks" on public.tasks
  for select to authenticated
  using (assignee_id = auth.uid() or public.is_admin());
-- Only admins assign tasks.
create policy "Admins create tasks" on public.tasks
  for insert to authenticated
  with check (public.is_admin());
-- Assignee can mark their own complete; admins can edit any.
create policy "Assignees and admins update tasks" on public.tasks
  for update to authenticated
  using (assignee_id = auth.uid() or public.is_admin())
  with check (assignee_id = auth.uid() or public.is_admin());
create policy "Admins delete tasks" on public.tasks
  for delete to authenticated
  using (public.is_admin());


-- ==========================================================================
-- 19. Push dispatch — fire a Web Push whenever a notification row is created
-- ==========================================================================
-- Every in-app notification (new order, order status, visit request, task)
-- already lands in public.notifications. This trigger forwards each new row
-- to the app's /api/push/dispatch endpoint, which checks the recipient's
-- per-category preference and sends the Web Push. It is fire-and-forget and
-- never blocks the insert. Requires pg_net.
--
-- The endpoint URL + shared secret live in public.app_settings (Supabase's
-- SQL editor can't set database-level GUCs). Configure them once with:
--
--   insert into public.app_settings (key, value) values
--     ('push_dispatch_url',    'https://YOUR-APP/api/push/dispatch'),
--     ('push_dispatch_secret', 'a-long-random-string')
--   on conflict (key) do update set value = excluded.value;
--
-- and set PUSH_DISPATCH_SECRET to the same value in the app's environment.
-- If push_dispatch_url is missing, push dispatch is skipped (the in-app
-- notification is still created).

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable — the push-dispatch trigger will no-op until it is enabled.';
end $$;

-- Small key/value config table for values the SQL editor can't set as GUCs.
create table if not exists public.app_settings (
  key   text primary key,
  value text
);
alter table public.app_settings enable row level security;
drop policy if exists "Admins manage app_settings" on public.app_settings;
create policy "Admins manage app_settings" on public.app_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- QuickBooks token-refresh audit trail is stored as a JSON array in
-- app_settings (key 'qb_token_log') by the server — no dedicated table needed.
-- Surfaced read-only to admins via /api/quickbooks/status.

create or replace function public.dispatch_push_for_notification()
returns trigger
language plpgsql
security definer
as $$
declare
  endpoint text;
  secret   text;
  pref_col text;
  pref_on  boolean;
  subs     jsonb;
begin
  select value into endpoint from public.app_settings where key = 'push_dispatch_url';
  select value into secret   from public.app_settings where key = 'push_dispatch_secret';
  if endpoint is null or endpoint = '' then
    return new;
  end if;

  -- Respect the recipient's per-category preference.
  pref_col := case
    when new.kind = 'task' then 'notify_on_task'
    when new.kind in ('new_order', 'pending_order', 'new_order_with_rep') then 'notify_on_new_order'
    when new.kind in ('order_status', 'out_for_delivery', 'delivered') then 'notify_on_order_status'
    when new.kind = 'business_link_request' then 'notify_on_new_customer'
    when new.kind in ('work_order_submitted', 'work_order_approved', 'work_order_funds', 'work_order_rejected') then 'notify_on_work_order'
    else null
  end;
  if pref_col is not null then
    execute format('select %I from public.profiles where id = $1', pref_col)
      into pref_on using new.recipient_id;
    if pref_on is false then return new; end if;
  end if;

  -- Gather the recipient's push subscriptions and hand them to the endpoint,
  -- so the app never needs the service-role key to send.
  select jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
    into subs
    from public.push_subscriptions ps
    where ps.user_id = new.recipient_id;
  if subs is null then return new; end if;

  perform net.http_post(
    url     := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(secret, '')),
    body    := jsonb_build_object(
      'subscriptions', subs,
      'payload', jsonb_build_object('title', new.title, 'body', new.body, 'url', new.link, 'tag', new.kind)
    )
  );
  return new;
exception when others then
  -- Never let a push problem block the notification insert.
  return new;
end;
$$;

drop trigger if exists trg_dispatch_push on public.notifications;
create trigger trg_dispatch_push
  after insert on public.notifications
  for each row execute function public.dispatch_push_for_notification();


-- ==========================================================================
-- 20. reminders — personal recurring reminders shown per staff member
-- ==========================================================================
-- Each staff member's own reminders (payroll, sales tax, ordering supplies…).
-- A daily cron (/api/cron/reminders) notifies the owner when one is due and
-- advances recurring ones to their next occurrence.

create table if not exists public.reminders (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  title           text not null,
  note            text,
  remind_on       date not null,
  repeat          text not null default 'once'
                    check (repeat in ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  notify_in_app   boolean not null default true,
  notify_email    boolean not null default false,
  active          boolean not null default true,
  last_notified_on date,
  created_at      timestamptz not null default now()
);
create index if not exists reminders_user_idx on public.reminders(user_id);
create index if not exists reminders_due_idx  on public.reminders(active, remind_on);

grant select, insert, update, delete on public.reminders to authenticated;
alter table public.reminders enable row level security;

drop policy if exists "Users manage their own reminders" on public.reminders;
create policy "Users manage their own reminders"
  on public.reminders for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ==========================================================================
-- 21. customer_documents access — customers manage own, admins read all
-- ==========================================================================
-- Customers upload their own docs (customer_id = themselves). Reps upload on
-- a customer's behalf via the service role. Admins/master_admins must be able
-- to read every customer's documents so they show on the Customers page.

alter table public.customer_documents enable row level security;

drop policy if exists "Customers manage their own documents" on public.customer_documents;
create policy "Customers manage their own documents" on public.customer_documents
  for all to authenticated
  using (customer_id = auth.uid())
  with check (customer_id = auth.uid());

drop policy if exists "Admins read all customer documents" on public.customer_documents;
create policy "Admins read all customer documents" on public.customer_documents
  for select to authenticated
  using (public.is_admin());

-- Storage: customers manage their own folder; admins can read any file so the
-- "Download" link on the admin Customers page works.
drop policy if exists "Customers manage own customer-documents" on storage.objects;
create policy "Customers manage own customer-documents" on storage.objects
  for all to authenticated
  using (bucket_id = 'customer-documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'customer-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Admins read customer-documents" on storage.objects;
create policy "Admins read customer-documents" on storage.objects
  for select to authenticated
  using (bucket_id = 'customer-documents' and public.is_admin());


-- ==========================================================================
-- 22. Master-admin customer delete — delete policies (no service role needed)
-- ==========================================================================
-- Lets a master admin delete a customer and their dependent rows through
-- their own session (the /api/admin/delete-customer route), the same way the
-- order delete works. is_master_admin() is security definer to avoid RLS
-- recursion when referenced from the profiles policy.

create or replace function public.is_master_admin()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'master_admin'
  );
$$;

drop policy if exists "Master admins delete customer profiles" on public.profiles;
create policy "Master admins delete customer profiles" on public.profiles
  for delete to authenticated
  using (public.is_master_admin() and role = 'customer');

drop policy if exists "Master admins delete customer_documents" on public.customer_documents;
create policy "Master admins delete customer_documents" on public.customer_documents
  for delete to authenticated using (public.is_master_admin());

drop policy if exists "Master admins delete customer_qb_mapping" on public.customer_qb_mapping;
create policy "Master admins delete customer_qb_mapping" on public.customer_qb_mapping
  for delete to authenticated using (public.is_master_admin());

drop policy if exists "Master admins delete notifications" on public.notifications;
create policy "Master admins delete notifications" on public.notifications
  for delete to authenticated using (public.is_master_admin());

-- Anyone may delete their OWN notifications (powers the bell's per-item ✕ and
-- "Clear all"). Without this, only master admins could delete, so a normal
-- user's delete was undone on the next poll.
drop policy if exists "Users delete own notifications" on public.notifications;
create policy "Users delete own notifications" on public.notifications
  for delete to authenticated using (recipient_id = auth.uid());


-- ==========================================================================
-- 23. Staff-uploaded customer documents (reps upload on a customer's behalf)
-- ==========================================================================
-- The Forms page uploads a customer's documents through the staff member's
-- own session, so staff need write access to customer_documents + the
-- customer-documents storage bucket. The upload route verifies the rep is
-- assigned to the business before writing.

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('office', 'admin', 'master_admin')
  );
$$;

drop policy if exists "Staff manage customer documents" on public.customer_documents;
create policy "Staff manage customer documents" on public.customer_documents
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

drop policy if exists "Staff manage customer-documents storage" on storage.objects;
create policy "Staff manage customer-documents storage" on storage.objects
  for all to authenticated
  using (bucket_id = 'customer-documents' and public.is_staff())
  with check (bucket_id = 'customer-documents' and public.is_staff());


-- ==========================================================================
-- 24. profiles.on_hold — new customer placed on hold pending documents
-- ==========================================================================
alter table public.profiles
  add column if not exists on_hold boolean not null default false,
  add column if not exists hold_reason text;


-- ==========================================================================
-- 26. Task resends — send_count + an admin notification helper
-- ==========================================================================
-- Re-sending a task bumps send_count (drives the escalating color + "Nth
-- request" label) and re-notifies the assignees. notify_recipients lets an
-- admin create notifications for others without the service-role key.

alter table public.tasks add column if not exists send_count int not null default 1;
-- Set when the assignee opens their Tasks page, so the sender sees "viewed".
alter table public.tasks add column if not exists viewed_at timestamptz;

create or replace function public.notify_recipients(
  recipient_ids uuid[], p_kind text, p_title text, p_body text, p_link text
)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  insert into public.notifications (recipient_id, kind, title, body, link)
  select unnest(recipient_ids), p_kind, p_title, p_body, p_link;
end;
$$;
grant execute on function public.notify_recipients(uuid[], text, text, text, text) to authenticated;


-- ==========================================================================
-- 27. Document applicability toggles — TC-721 / W-9 "required for this
--     customer?" flags that drive the "Missing documents" check.
-- ==========================================================================
-- Default true so every existing customer is expected to have these on file;
-- an admin toggles a customer off when the form genuinely doesn't apply
-- (e.g. a non-exempt buyer doesn't need a TC-721). Combined with the always-
-- required profile sheet + business name/address/email/phone, this lets the
-- Customers page flag anyone with an incomplete file.
alter table public.profiles
  add column if not exists tax_exempt_applicable boolean not null default true,
  add column if not exists w9_applicable         boolean not null default true;

-- Hard document gate for self-signup customers only. New shop signups are
-- flagged docs_required = true and cannot check out until their required
-- documents are on file (profile sheet + W-9, plus TC-721 if tax-exempt).
-- Defaults false so existing/QB-imported customers are never retroactively
-- blocked — admins still see their missing docs via the flags above.
alter table public.profiles
  add column if not exists docs_required boolean not null default false;


-- ==========================================================================
-- 28. businesses.qb_last_purchase_date — most recent QB invoice date
-- ==========================================================================
-- Populated by /api/quickbooks/sync-balances (and the nightly cron). Shows
-- "Last order" on /admin/customers so admins can spot customers who haven't
-- bought from us in a while.
alter table public.businesses
  add column if not exists qb_last_purchase_date date;


-- ==========================================================================
-- 28b. businesses.qb_recent_invoice_dates — last 12 QB invoice dates
-- ==========================================================================
-- Populated by the same nightly balance sync (free — it already scans invoices
-- newest-first). Powers the order-cadence bubble on /admin/customers: combined
-- it lets us show how often a customer
-- orders and count down to their expected next order so the rep can check in.
alter table public.businesses
  add column if not exists qb_recent_invoice_dates date[];


-- ==========================================================================
-- ==========================================================================
-- 31. Messaging — boards, membership, messages, read state, avatars
-- ==========================================================================
-- A lightweight message-board + DM system that mirrors the notification bell:
-- the top-bar message bubble shows an unread red badge and fires a Web Push
-- when the app is closed. Read state is tracked per (board, user) via
-- last_read_at; the UI shows a small avatar for each member who has read up to
-- a given message (profile photo, or initials when none is uploaded).
--
-- Boards:
--   * all_staff = true  -> the default staff board: every staff user can see
--                          and post; no explicit membership row needed.
--   * all_staff = false -> an extra board (multi-board mode) or a DM. Access is
--                          by explicit board_members rows. Admins add/remove.
--   * kind = 'dm'       -> a 1:1 direct thread (customer<->rep, staff<->staff).
--
-- board_members rows double as read-state (last_read_at) and are created
-- lazily when a user first opens a board, even on all_staff boards.

alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists message_alert_mode text not null default 'sound'
    check (message_alert_mode in ('sound', 'vibrate', 'silent'));

create table if not exists public.message_boards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'board' check (kind in ('board', 'dm')),
  all_staff   boolean not null default false,
  is_default  boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null
);
create index if not exists message_boards_sort_idx on public.message_boards(sort_order);

create table if not exists public.board_members (
  board_id     uuid not null references public.message_boards(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  added_by     uuid references public.profiles(id) on delete set null,
  last_read_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index if not exists board_members_user_idx on public.board_members(user_id);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.message_boards(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_board_idx on public.messages(board_id, created_at);

-- Attachments on a message (photo / file / video). Stored in the
-- 'message-media' bucket; the row keeps the storage path + metadata. body may
-- be empty when a message is attachment-only.
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_type text;  -- mime type
alter table public.messages add column if not exists attachment_name text;
alter table public.messages alter column body drop not null;

-- Can the current user see / post to this board?
create or replace function public.can_access_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.message_boards mb
    where mb.id = b
      and (
        (mb.all_staff and public.is_staff())
        or exists (select 1 from public.board_members m
                   where m.board_id = b and m.user_id = auth.uid())
      )
  );
$$;
grant execute on function public.can_access_board(uuid) to authenticated;

-- message-media bucket: private. Access is gated to members of the board the
-- file belongs to — the storage path is '<board_id>/<filename>', so we check
-- can_access_board on the first path segment.
insert into storage.buckets (id, name, public)
  values ('message-media', 'message-media', false)
  on conflict (id) do nothing;
drop policy if exists "message media read"  on storage.objects;
drop policy if exists "message media write" on storage.objects;
create policy "message media read" on storage.objects for select to authenticated
  using (bucket_id = 'message-media'
         and public.can_access_board(((storage.foldername(name))[1])::uuid));
create policy "message media write" on storage.objects for insert to authenticated
  with check (bucket_id = 'message-media'
              and public.can_access_board(((storage.foldername(name))[1])::uuid));



-- Seed the default staff board once.
insert into public.message_boards (name, kind, all_staff, is_default, sort_order)
select 'Team', 'board', true, true, 0
where not exists (select 1 from public.message_boards where is_default);

grant select, insert, update, delete on public.message_boards to authenticated;
grant select, insert, update, delete on public.board_members to authenticated;
grant select, insert, update, delete on public.messages to authenticated;

alter table public.message_boards enable row level security;
alter table public.board_members enable row level security;
alter table public.messages enable row level security;

-- Boards: readable if accessible; admins manage everything; anyone may create
-- a DM board (the ensure_dm RPC enforces who can DM whom).
drop policy if exists "boards read"      on public.message_boards;
drop policy if exists "boards admin all" on public.message_boards;
drop policy if exists "boards dm create" on public.message_boards;
create policy "boards read" on public.message_boards for select to authenticated
  using (public.can_access_board(id));
create policy "boards admin all" on public.message_boards for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "boards dm create" on public.message_boards for insert to authenticated
  with check (kind = 'dm' and not all_staff and not is_default);

-- Members: readable by anyone who can access the board. A user manages their
-- OWN row (joining DMs + saving read-state). Admins add/remove anyone.
drop policy if exists "members read"        on public.board_members;
drop policy if exists "members self insert" on public.board_members;
drop policy if exists "members self update" on public.board_members;
drop policy if exists "members admin all"   on public.board_members;
create policy "members read" on public.board_members for select to authenticated
  using (public.can_access_board(board_id));
create policy "members self insert" on public.board_members for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_board(board_id));
create policy "members self update" on public.board_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members admin all" on public.board_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Messages: read/post if you can access the board; only admins delete.
drop policy if exists "messages read"         on public.messages;
drop policy if exists "messages send"         on public.messages;
drop policy if exists "messages admin delete" on public.messages;
create policy "messages read" on public.messages for select to authenticated
  using (public.can_access_board(board_id));
create policy "messages send" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.can_access_board(board_id));
create policy "messages admin delete" on public.messages for delete to authenticated
  using (public.is_admin());

-- Find-or-create a 1:1 DM between the caller and `other`. Customers may DM
-- staff (and vice-versa); customer<->customer is rejected.
create or replace function public.ensure_dm(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  me  uuid := auth.uid();
begin
  if me is null or other is null or me = other then
    raise exception 'invalid dm';
  end if;
  if not (
        public.is_staff()
        or exists (select 1 from public.profiles
                   where id = other and role in ('office','driver','mechanic','contractor','admin','master_admin'))
     ) then
    raise exception 'not allowed';
  end if;

  select mb.id into bid
    from public.message_boards mb
   where mb.kind = 'dm'
     and (select count(*) from public.board_members m where m.board_id = mb.id) = 2
     and exists (select 1 from public.board_members m where m.board_id = mb.id and m.user_id = me)
     and exists (select 1 from public.board_members m where m.board_id = mb.id and m.user_id = other)
   limit 1;
  if bid is not null then return bid; end if;

  insert into public.message_boards (name, kind, all_staff, created_by)
    values ('Direct message', 'dm', false, me) returning id into bid;
  insert into public.board_members (board_id, user_id, added_by)
    values (bid, me, me), (bid, other, me);
  return bid;
end;
$$;
grant execute on function public.ensure_dm(uuid) to authenticated;

-- Rename a chat (name only). Admins may rename any board; a DM may be renamed
-- by either participant. Keeps the rest of the row locked down.
create or replace function public.rename_board(b uuid, new_name text)
returns void language plpgsql security definer set search_path = public as $$
declare brd record;
begin
  select * into brd from public.message_boards where id = b;
  if not found then raise exception 'board not found'; end if;
  if btrim(coalesce(new_name, '')) = '' then raise exception 'name required'; end if;
  if public.is_admin()
     or (brd.kind = 'dm' and exists (
           select 1 from public.board_members m
           where m.board_id = b and m.user_id = auth.uid()))
  then
    update public.message_boards set name = btrim(new_name) where id = b;
  else
    raise exception 'not allowed';
  end if;
end;
$$;
grant execute on function public.rename_board(uuid, text) to authenticated;

-- Create a multi-person chat: a non-default board with the caller + the given
-- members. Any staff member may create one.
create or replace function public.create_group_chat(p_name text, member_ids uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  me  uuid := auth.uid();
  uid uuid;
begin
  if not public.is_staff() then raise exception 'staff only'; end if;
  insert into public.message_boards (name, kind, all_staff, created_by)
    values (coalesce(nullif(btrim(p_name), ''), 'New chat'), 'board', false, me)
    returning id into bid;
  insert into public.board_members (board_id, user_id, added_by)
    values (bid, me, me) on conflict do nothing;
  if member_ids is not null then
    foreach uid in array member_ids loop
      if uid is not null and uid <> me then
        insert into public.board_members (board_id, user_id, added_by)
          values (bid, uid, me) on conflict do nothing;
      end if;
    end loop;
  end if;
  return bid;
end;
$$;
grant execute on function public.create_group_chat(text, uuid[]) to authenticated;

-- Delete a chat (cascades to its members + messages). Admins may delete any
-- chat; a DM or group chat may be deleted by any of its members. The default
-- board is protected.
create or replace function public.delete_board(b uuid)
returns void language plpgsql security definer set search_path = public as $$
declare brd record;
begin
  select * into brd from public.message_boards where id = b;
  if not found then return; end if;
  if brd.is_default then raise exception 'cannot delete the default board'; end if;
  if public.is_admin()
     or exists (select 1 from public.board_members m
                where m.board_id = b and m.user_id = auth.uid())
  then
    delete from public.message_boards where id = b;
  else
    raise exception 'not allowed';
  end if;
end;
$$;
grant execute on function public.delete_board(uuid) to authenticated;

-- Add / remove members of a group chat. Admins may manage any board; a member
-- of a (non-default, non-all-staff) group chat may manage that group.
create or replace function public.can_manage_group(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    exists (select 1 from public.board_members
            where board_id = b and user_id = auth.uid())
    and exists (select 1 from public.message_boards
            where id = b and kind = 'board' and not all_staff and not is_default)
  );
$$;
grant execute on function public.can_manage_group(uuid) to authenticated;

create or replace function public.add_group_member(b uuid, u uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_group(b) then raise exception 'not allowed'; end if;
  insert into public.board_members (board_id, user_id, added_by)
    values (b, u, auth.uid()) on conflict do nothing;
end;
$$;
grant execute on function public.add_group_member(uuid, uuid) to authenticated;

create or replace function public.remove_group_member(b uuid, u uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_group(b) then raise exception 'not allowed'; end if;
  delete from public.board_members where board_id = b and user_id = u;
end;
$$;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

-- Avatars: a public bucket; each user writes only under their own uid/ prefix.
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
drop policy if exists "avatars public read" on storage.objects;
drop policy if exists "avatars self write"  on storage.objects;
create policy "avatars public read" on storage.objects for select
  using (bucket_id = 'avatars');
create policy "avatars self write" on storage.objects for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Web Push for a new message: one POST per recipient (so each honors their own
-- alert mode), pointing at the right route for their role. Fire-and-forget.
create or replace function public.dispatch_push_for_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  endpoint     text;
  secret       text;
  sender_label text;
  rec          record;
  subs         jsonb;
begin
  select value into endpoint from public.app_settings where key = 'push_dispatch_url';
  select value into secret   from public.app_settings where key = 'push_dispatch_secret';
  if endpoint is null or endpoint = '' then return new; end if;

  select coalesce(full_name, email) into sender_label
    from public.profiles where id = new.sender_id;

  for rec in
    select prof.id as uid, prof.role as role, prof.message_alert_mode as mode
      from public.profiles prof
     where prof.id <> new.sender_id
       and (
         exists (select 1 from public.message_boards b
                  where b.id = new.board_id and b.all_staff
                    and prof.role in ('office','driver','mechanic','contractor','admin','master_admin'))
         or exists (select 1 from public.board_members m
                     where m.board_id = new.board_id and m.user_id = prof.id)
       )
  loop
    select jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
      into subs from public.push_subscriptions ps where ps.user_id = rec.uid;
    if subs is null then continue; end if;

    perform net.http_post(
      url     := endpoint,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(secret, '')),
      body    := jsonb_build_object(
        'subscriptions', subs,
        'payload', jsonb_build_object(
          'title',   coalesce(sender_label, 'New message'),
          'body',    coalesce(left(new.body, 140), case when new.attachment_path is not null then '📎 Attachment' else '' end),
          'url',     case when rec.role = 'customer' then '/shop/messages?b=' else '/messages?b=' end || new.board_id,
          'tag',     'msg-' || new.board_id,
          'silent',  (rec.mode = 'silent'),
          'vibrate', (rec.mode = 'vibrate')
        )
      )
    );
  end loop;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_dispatch_push_message on public.messages;
create trigger trg_dispatch_push_message
  after insert on public.messages
  for each row execute function public.dispatch_push_for_message();


-- ==========================================================================
-- 33. businesses.billing_notes — special billing instructions per customer
-- ==========================================================================
-- Free-text instructions an admin sets on a business (Customers page). They
-- surface on the admin "Delivered" orders view so the office knows what to do
-- when that customer's invoice is delivered (e.g. "email + regular mail").
alter table public.businesses add column if not exists billing_notes text;


-- ==========================================================================
-- 35. Keep businesses in sync with imported QuickBooks customers
-- ==========================================================================
-- The QB customer sync writes profiles (imported customers). This function
-- ensures every customer profile is linked to a businesses row, matched by
-- qb_customer_id first, then by name, so newly-synced QB customers show up in
-- the admin "Link to a different business" dropdown and invoice straight to
-- the right QB customer. Idempotent; called at the end of the sync.
create or replace function public.link_qb_profiles_to_businesses()
returns int language plpgsql security definer set search_path = public as $$
declare
  prof record;
  biz_id uuid;
  biz_name text;
  linked int := 0;
begin
  for prof in
    select id, full_name, email, business_name, phone, address, imported_from_qb_customer_id
    from public.profiles
    where role = 'customer' and business_id is null
  loop
    biz_name := coalesce(nullif(trim(prof.business_name), ''),
                         nullif(trim(prof.full_name), ''), prof.email);
    biz_id := null;

    -- 1) existing business already carrying this QB customer id
    if prof.imported_from_qb_customer_id is not null then
      select id into biz_id from public.businesses
        where qb_customer_id = prof.imported_from_qb_customer_id limit 1;
    end if;

    -- 2) else match an existing business by name (case-insensitive)
    if biz_id is null and biz_name is not null then
      select id into biz_id from public.businesses
        where lower(name) = lower(biz_name) limit 1;
      -- backfill its QB id if it didn't have one
      if biz_id is not null and prof.imported_from_qb_customer_id is not null then
        update public.businesses set qb_customer_id = prof.imported_from_qb_customer_id
          where id = biz_id and qb_customer_id is null;
      end if;
    end if;

    -- 3) else create a new business
    if biz_id is null then
      insert into public.businesses (name, address, phone, qb_customer_id, created_at)
        values (biz_name, prof.address, prof.phone, prof.imported_from_qb_customer_id, now())
        returning id into biz_id;
    end if;

    update public.profiles set business_id = biz_id, is_business_owner = true
      where id = prof.id;
    linked := linked + 1;
  end loop;
  return linked;
end $$;
grant execute on function public.link_qb_profiles_to_businesses() to authenticated;

-- Merge one business into another: move members + orders, carry the QB id, then
-- delete the source. For when a customer signed up under a personal name and a
-- duplicate business was created alongside the real QB-synced one.
create or replace function public.merge_businesses(source_id uuid, target_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  if source_id = target_id then return; end if;
  -- carry the QB id onto the target if it lacks one
  update public.businesses t set qb_customer_id = s.qb_customer_id
    from public.businesses s
    where t.id = target_id and s.id = source_id
      and t.qb_customer_id is null and s.qb_customer_id is not null;
  update public.profiles set business_id = target_id where business_id = source_id;
  delete from public.businesses where id = source_id;
end $$;
grant execute on function public.merge_businesses(uuid, uuid) to authenticated;


-- ==========================================================================
-- 34. feature_flags — master-admin show/hide of nav tabs per role
-- ==========================================================================
-- Each key is "role:href" (e.g. 'admin:/admin/bills', 'driver:/driver/inventory').
-- A row with enabled = false hides that tab from that role's menu. Absence of a
-- row = visible (default). Everyone can read (to render their nav); only master
-- admins can change them (Settings tab).
create table if not exists public.feature_flags (
  key        text primary key,
  enabled    boolean not null default true,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.feature_flags to authenticated;
alter table public.feature_flags enable row level security;
drop policy if exists "Anyone reads feature_flags" on public.feature_flags;
create policy "Anyone reads feature_flags" on public.feature_flags
  for select to authenticated using (true);
drop policy if exists "Master admins manage feature_flags" on public.feature_flags;
create policy "Master admins manage feature_flags" on public.feature_flags
  for all to authenticated using (public.is_master_admin()) with check (public.is_master_admin());


-- ==========================================================================
-- 35. service_role grants — let server jobs reach every table
-- ==========================================================================
-- The service-role key bypasses RLS but still needs table PRIVILEGES. Some
-- tables (quickbooks_connection, vendor_bills, …) were never granted to it,
-- which caused "permission denied" in cron jobs and the auto-invoice bypass
-- (a driver-placed order couldn't be invoiced + posted to the warehouse).
-- Grant the service role everything, including future tables, so server-side
-- work always succeeds.
-- Short lock used to serialize QuickBooks token refreshes so concurrent calls
-- (a cron + a user action) don't reuse the refresh token and get the whole
-- connection revoked by Intuit. Guarded because the table is created by the app.
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'quickbooks_connection') then
    alter table public.quickbooks_connection add column if not exists refresh_locked_until timestamptz;
  end if;
end $$;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;


-- ==========================================================================
-- 36. admin_tasks — master-admin recurring business reminders (with completion)
-- ==========================================================================
-- Sales tax, fuel-tax form, payroll, reconciling, statements, etc. Each has a
-- next due date and a repeat; marking it complete records when, and advances
-- the due date to the next cycle. A daily cron notifies master admins when one
-- comes due. Master admins only.
create table if not exists public.admin_tasks (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  note              text,
  due_date          date not null,
  repeat            text not null default 'once'
                      check (repeat in ('once','weekly','biweekly','monthly','quarterly','yearly')),
  last_completed_at timestamptz,
  last_notified_on  date,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);
create index if not exists admin_tasks_due_idx on public.admin_tasks(due_date) where active;
grant select, insert, update, delete on public.admin_tasks to authenticated;
alter table public.admin_tasks enable row level security;
drop policy if exists "Master admins manage admin_tasks" on public.admin_tasks;
create policy "Master admins manage admin_tasks" on public.admin_tasks
  for all to authenticated using (public.is_master_admin()) with check (public.is_master_admin());


-- ==========================================================================
-- 24. purchase_orders — admin PO log with an auto-incrementing PO number
-- ==========================================================================
-- Admins record a purchase order per row: PO #, date, amount, description,
-- job/invoice reference, and the initials of the admin who approved it. The PO
-- number auto-increments (max existing + 1, starting at the app's PO_START) so
-- the next number is always displayed on the blank entry row. Admin-only.

create table if not exists public.purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  po_number       integer not null unique,
  po_date         date not null default current_date,
  amount          numeric(12,2),
  description     text,
  job_invoice     text,
  approved_by     text,          -- initials of the admin who initiated the PO (auto)
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_name text,
  edited_at       timestamptz,   -- set when a PO is edited after creation
  canceled_at     timestamptz,   -- soft-cancel: row stays, shown gray (not deleted)
  created_at      timestamptz not null default now()
);
-- Backfill columns on existing installs.
alter table public.purchase_orders add column if not exists edited_at   timestamptz;
alter table public.purchase_orders add column if not exists canceled_at timestamptz;
-- PO → QuickBooks Bill: vendor + the created bill's ids so a PO can be pushed
-- (auto on save, or via an "edit & push" button) into QuickBooks accounts payable.
alter table public.purchase_orders add column if not exists vendor_name  text;
alter table public.purchase_orders add column if not exists vendor_qb_id text;
alter table public.purchase_orders add column if not exists qb_bill_id   text;
alter table public.purchase_orders add column if not exists qb_bill_doc  text;
alter table public.purchase_orders add column if not exists qb_pushed_at timestamptz;
create index if not exists purchase_orders_number_idx on public.purchase_orders(po_number);

-- The expense account PO bills post to (picked once on the PO screen).
insert into public.app_settings (key, value) values
  ('po_expense_account_id',   ''),
  ('po_expense_account_name', '')
on conflict (key) do nothing;

grant select, insert, update, delete on public.purchase_orders to authenticated;
alter table public.purchase_orders enable row level security;

drop policy if exists "Admins view purchase orders"   on public.purchase_orders;
drop policy if exists "Admins create purchase orders" on public.purchase_orders;
drop policy if exists "Admins update purchase orders" on public.purchase_orders;
drop policy if exists "Admins delete purchase orders" on public.purchase_orders;

create policy "Admins view purchase orders" on public.purchase_orders
  for select to authenticated using (public.is_admin());
create policy "Admins create purchase orders" on public.purchase_orders
  for insert to authenticated with check (public.is_admin());
create policy "Admins update purchase orders" on public.purchase_orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins delete purchase orders" on public.purchase_orders
  for delete to authenticated using (public.is_admin());


-- ==========================================================================
-- 37. work_orders — field tickets (the core of the app)
-- ==========================================================================
-- One row per field ticket. A crew member fills it out in the field (with a
-- photo of the paper ticket), the office reviews/edits/approves it and
-- invoices the customer in QuickBooks, the contractor approves their crew's
-- portion, and the funder (Auto 1) approves funds against it.
--
--   draft -> submitted -> office_approved -> funds_approved -> invoiced
--
-- Approvals are gated in the API routes (app/api/work-orders/*), which run as
-- the service role and write only the columns that role is allowed to touch.
-- RLS below decides WHO can see and write a row at all.

create table if not exists public.work_orders (
  id                     uuid primary key default gen_random_uuid(),

  -- Who / what job
  customer_id            uuid references public.profiles(id) on delete set null,
  business_id            uuid references public.businesses(id) on delete set null,
  customer_number        text,
  job_number             text,
  job_name               text,
  day_number             text,
  phase_code             text,
  claim_number           text,
  unit_number            text,          -- the truck on this ticket
  equipment_type         text,          -- belly dump, end dump, water truck…
  fsr                    text,          -- Field Service Rep (name or ref)

  -- Time + amounts (worked hours are computed from start/stop, plus travel/down)
  job_date               date,
  start_at               timestamptz,
  stop_at                timestamptz,
  travel_hours           numeric(6,2),
  down_hours             numeric(6,2),
  rate                   numeric(12,2),
  tonnage                numeric(12,2),
  tonnage_type           text,

  -- Attachments (Storage: work-tickets bucket)
  ticket_photo_path      text,
  short_ticket_path      text,
  signature_path         text,

  -- Ownership
  submitted_by           uuid references public.profiles(id) on delete set null,
  contractor_id          uuid references public.profiles(id) on delete set null,
  submitted_at           timestamptz,

  -- Approval chain
  status                 text not null default 'draft'
    check (status in ('draft','submitted','office_approved','funds_approved','invoiced','rejected')),
  office_approved_by     uuid references public.profiles(id) on delete set null,
  office_approved_at     timestamptz,
  contractor_approved_by uuid references public.profiles(id) on delete set null,
  contractor_approved_at timestamptz,
  funder_approved_by     uuid references public.profiles(id) on delete set null,
  funder_approved_at     timestamptz,
  rejected_reason        text,

  -- QuickBooks link (office invoices the customer)
  qb_invoice_id          text,
  qb_invoice_number      text,
  qb_synced_at           timestamptz,

  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Columns added after the first release. `create table if not exists` above
-- is a no-op on a project that already has the table, so anything added
-- later has to be applied here too for this file to stay re-runnable.
alter table public.work_orders add column if not exists job_name       text;
alter table public.work_orders add column if not exists equipment_type text;

create index if not exists work_orders_status_idx     on public.work_orders(status, job_date desc);
create index if not exists work_orders_submitter_idx  on public.work_orders(submitted_by, created_at desc);
create index if not exists work_orders_contractor_idx on public.work_orders(contractor_id, created_at desc);
create index if not exists work_orders_customer_idx   on public.work_orders(customer_id);
create index if not exists work_orders_job_idx        on public.work_orders(job_number);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_work_orders_touch on public.work_orders;
create trigger trg_work_orders_touch before update on public.work_orders
  for each row execute function public.touch_updated_at();

grant select, insert, update, delete on public.work_orders to authenticated;
alter table public.work_orders enable row level security;

-- Admins + office manage everything (review, edit, approve, invoice).
drop policy if exists "wo office manage" on public.work_orders;
create policy "wo office manage" on public.work_orders
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));

-- Crew (driver / contractor crew) create tickets and read/edit their OWN while
-- still draft or submitted. They can't touch approvals.
drop policy if exists "wo crew insert" on public.work_orders;
create policy "wo crew insert" on public.work_orders
  for insert to authenticated
  with check (submitted_by = auth.uid());

drop policy if exists "wo crew read own" on public.work_orders;
create policy "wo crew read own" on public.work_orders
  for select to authenticated
  using (submitted_by = auth.uid());

-- 'rejected' is in the list because a ticket the office sent back has to be
-- fixable: the crew edits it and submits again.
drop policy if exists "wo crew edit own draft" on public.work_orders;
create policy "wo crew edit own draft" on public.work_orders
  for update to authenticated
  using (submitted_by = auth.uid() and status in ('draft','submitted','rejected'))
  with check (submitted_by = auth.uid() and status in ('draft','submitted','rejected'));

-- Contractor: read every ticket for their crews and approve their portion.
drop policy if exists "wo contractor read" on public.work_orders;
create policy "wo contractor read" on public.work_orders
  for select to authenticated
  using (public.has_role(array['contractor']) and contractor_id = auth.uid());

drop policy if exists "wo contractor approve" on public.work_orders;
create policy "wo contractor approve" on public.work_orders
  for update to authenticated
  using (public.has_role(array['contractor']) and contractor_id = auth.uid())
  with check (public.has_role(array['contractor']) and contractor_id = auth.uid());

-- Funder (Auto 1): read ALL orders and approve funds.
drop policy if exists "wo funder read" on public.work_orders;
create policy "wo funder read" on public.work_orders
  for select to authenticated
  using (public.has_role(array['funder']));

drop policy if exists "wo funder approve" on public.work_orders;
create policy "wo funder approve" on public.work_orders
  for update to authenticated
  using (public.has_role(array['funder']))
  with check (public.has_role(array['funder']));

-- NOTE on approvals: RLS controls WHO can write a row, not WHICH columns. The
-- "contractor may only set contractor_approved_*, funder only funder_*, crew
-- can't self-approve" rule is enforced server-side in the approval routes,
-- which run with the service role and set exactly the allowed fields.


-- The office picks the QuickBooks item every ticket bills against, on the Work
-- Orders setup screen. app_settings is otherwise admin-only, so office gets a
-- narrow policy over just those two keys.
drop policy if exists "Office manages work order settings" on public.app_settings;
create policy "Office manages work order settings" on public.app_settings
  for all to authenticated
  using (public.has_role(array['office']) and key like 'work_order_%')
  with check (public.has_role(array['office']) and key like 'work_order_%');


-- ==========================================================================
-- 38. job_rates — the contractor's agreed rate per job/phase
-- ==========================================================================
-- What each job pays, so the ticket form can default `rate` and the contractor
-- has a Rates tab to check against. Office/admin maintain them; contractors and
-- crew read them.

create table if not exists public.job_rates (
  id             uuid primary key default gen_random_uuid(),
  job_number     text not null,
  phase_code     text,
  description    text,
  rate           numeric(12,2) not null default 0,
  rate_unit      text not null default 'hour' check (rate_unit in ('hour','ton','load','day')),
  contractor_id  uuid references public.profiles(id) on delete set null,
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);
create unique index if not exists job_rates_job_phase_idx
  on public.job_rates(job_number, coalesce(phase_code, ''));
grant select, insert, update, delete on public.job_rates to authenticated;
alter table public.job_rates enable row level security;

drop policy if exists "job_rates staff read"   on public.job_rates;
drop policy if exists "job_rates office write" on public.job_rates;
create policy "job_rates staff read" on public.job_rates
  for select to authenticated using (true);
create policy "job_rates office write" on public.job_rates
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));


-- ==========================================================================
-- 39. Storage — work-tickets bucket (ticket photos + short tickets)
-- ==========================================================================
insert into storage.buckets (id, name, public)
  values ('work-tickets', 'work-tickets', false)
  on conflict (id) do nothing;

-- Crew upload their own ticket photos; staff can also upload.
drop policy if exists "wt write" on storage.objects;
create policy "wt write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'work-tickets');

-- Staff (admin / office / contractor / funder) read any ticket file; crew read
-- the files they uploaded themselves (stored under a "<uid>/" path prefix).
drop policy if exists "wt staff read" on storage.objects;
create policy "wt staff read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'work-tickets'
    and (
      public.is_admin()
      or public.has_role(array['office','contractor','funder'])
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "wt staff delete" on storage.objects;
create policy "wt staff delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'work-tickets'
    and (public.is_admin() or public.has_role(array['office']))
  );


-- ==========================================================================
-- 40. Haulers — the hauling companies that run loads for Stallion
-- ==========================================================================
-- A hauler is a company, not a person. Its people sign in with role 'hauler'
-- and a profiles.hauler_id pointing at the company, so everything a hauler
-- can see is scoped by "same company as me" rather than "rows I created".
--
-- Four tables:
--   haulers               the company record the office maintains
--   hauler_equipment      the trucks and equipment that company owns
--   hauler_availability   date ranges a unit is free or blocked out
--   hauler_loads          a load offered to / assigned to a hauler
-- ==========================================================================

create table if not exists public.haulers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  contact_name       text,
  phone              text,
  email              text,
  address            text,
  mc_number          text,
  dot_number         text,
  insurance_expires  date,
  active             boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists haulers_name_key on public.haulers (lower(name));
create index if not exists haulers_active_idx on public.haulers (active, name);

-- A hauler login belongs to one company. Null for everyone else.
alter table public.profiles
  add column if not exists hauler_id uuid references public.haulers(id) on delete set null;
create index if not exists profiles_hauler_idx on public.profiles (hauler_id);

-- 'hauler' joins the role list. Re-running this is safe: the constraint is
-- dropped and rebuilt with the full set every time.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'driver', 'contractor', 'funder', 'master_admin',
                  'customer', 'office', 'mechanic', 'labor', 'hauler'));

-- ---- Equipment ----------------------------------------------------------
create table if not exists public.hauler_equipment (
  id             uuid primary key default gen_random_uuid(),
  hauler_id      uuid not null references public.haulers(id) on delete cascade,
  unit_number    text,
  equipment_type text,
  description    text,
  capacity       text,          -- e.g. "24 ton", "40 yd"
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists hauler_equipment_hauler_idx
  on public.hauler_equipment (hauler_id, active);

-- ---- Availability -------------------------------------------------------
-- One row per window. equipment_id null means the whole company (e.g. shut
-- down for a week); a row with equipment_id blocks just that unit.
create table if not exists public.hauler_availability (
  id           uuid primary key default gen_random_uuid(),
  hauler_id    uuid not null references public.haulers(id) on delete cascade,
  equipment_id uuid references public.hauler_equipment(id) on delete cascade,
  start_date   date not null,
  end_date     date not null,
  status       text not null default 'available'
    check (status in ('available', 'blocked')),
  note         text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint hauler_availability_range check (end_date >= start_date)
);
create index if not exists hauler_availability_hauler_idx
  on public.hauler_availability (hauler_id, start_date, end_date);

-- ---- Loads --------------------------------------------------------------
-- A load can be offered before any ticket exists, so it carries its own job
-- details and only links to a work order once one is filled out against it.
create table if not exists public.hauler_loads (
  id             uuid primary key default gen_random_uuid(),
  hauler_id      uuid not null references public.haulers(id) on delete cascade,
  equipment_id   uuid references public.hauler_equipment(id) on delete set null,
  work_order_id  uuid references public.work_orders(id) on delete set null,

  job_number     text,
  job_name       text,
  phase_code     text,
  equipment_type text,          -- what the job needs, if no unit is named yet
  job_date       date,
  start_time     text,
  pickup         text,
  dropoff        text,
  rate           numeric(12,2),
  rate_unit      text,
  notes          text,

  status         text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'assigned',
                      'completed', 'cancelled')),
  assigned_by    uuid references public.profiles(id) on delete set null,
  responded_by   uuid references public.profiles(id) on delete set null,
  responded_at   timestamptz,
  decline_reason text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists hauler_loads_hauler_idx
  on public.hauler_loads (hauler_id, status, job_date desc);
create index if not exists hauler_loads_job_idx on public.hauler_loads (job_number);

-- keep updated_at fresh on all three
drop trigger if exists trg_haulers_touch on public.haulers;
create trigger trg_haulers_touch before update on public.haulers
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_hauler_equipment_touch on public.hauler_equipment;
create trigger trg_hauler_equipment_touch before update on public.hauler_equipment
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_hauler_loads_touch on public.hauler_loads;
create trigger trg_hauler_loads_touch before update on public.hauler_loads
  for each row execute function public.touch_updated_at();

-- ---- Who am I? ----------------------------------------------------------
-- The hauler company of the signed-in user. Used by every hauler policy
-- below; security definer so reading it doesn't recurse into profiles' RLS.
create or replace function public.my_hauler_id()
returns uuid language sql stable security definer set search_path = public as $$
  select hauler_id from public.profiles where id = auth.uid();
$$;
grant execute on function public.my_hauler_id() to authenticated;

-- ---- RLS ----------------------------------------------------------------
grant select, insert, update, delete on public.haulers            to authenticated;
grant select, insert, update, delete on public.hauler_equipment   to authenticated;
grant select, insert, update, delete on public.hauler_availability to authenticated;
grant select, insert, update, delete on public.hauler_loads       to authenticated;

alter table public.haulers             enable row level security;
alter table public.hauler_equipment    enable row level security;
alter table public.hauler_availability enable row level security;
alter table public.hauler_loads        enable row level security;

-- haulers: staff manage the directory; a hauler reads only its own company.
drop policy if exists "haulers staff manage" on public.haulers;
create policy "haulers staff manage" on public.haulers
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));

drop policy if exists "haulers read own" on public.haulers;
create policy "haulers read own" on public.haulers
  for select to authenticated
  using (id = public.my_hauler_id());

-- Dispatch needs to see who's out there; funders see who ran the work.
drop policy if exists "haulers staff read" on public.haulers;
create policy "haulers staff read" on public.haulers
  for select to authenticated
  using (public.has_role(array['driver', 'contractor', 'funder']));

-- equipment: staff manage any; a hauler manages its own fleet.
drop policy if exists "hauler equip staff manage" on public.hauler_equipment;
create policy "hauler equip staff manage" on public.hauler_equipment
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));

drop policy if exists "hauler equip own manage" on public.hauler_equipment;
create policy "hauler equip own manage" on public.hauler_equipment
  for all to authenticated
  using (hauler_id = public.my_hauler_id())
  with check (hauler_id = public.my_hauler_id());

-- availability: same shape — the office can block a hauler out too.
drop policy if exists "hauler avail staff manage" on public.hauler_availability;
create policy "hauler avail staff manage" on public.hauler_availability
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));

drop policy if exists "hauler avail own manage" on public.hauler_availability;
create policy "hauler avail own manage" on public.hauler_availability
  for all to authenticated
  using (hauler_id = public.my_hauler_id())
  with check (hauler_id = public.my_hauler_id());

-- loads: the office offers and assigns them. A hauler READS its own loads but
-- cannot write them — accept/decline goes through the API route, the same way
-- ticket approvals do, so a hauler can never set its own rate or status.
drop policy if exists "hauler loads staff manage" on public.hauler_loads;
create policy "hauler loads staff manage" on public.hauler_loads
  for all to authenticated
  using (public.is_admin() or public.has_role(array['office']))
  with check (public.is_admin() or public.has_role(array['office']));

drop policy if exists "hauler loads read own" on public.hauler_loads;
create policy "hauler loads read own" on public.hauler_loads
  for select to authenticated
  using (hauler_id = public.my_hauler_id());


-- ==========================================================================
-- DONE
-- ==========================================================================
