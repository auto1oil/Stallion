-- ==========================================================================
-- Migration 001 — drop the tables behind the removed features
-- ==========================================================================
-- Run this ONLY on a project that was set up from the old Auto 1 Dispatch
-- schema and is being converted to the field-ticket app. A fresh project set
-- up from supabase-setup.sql never had these tables, so this migration is a
-- no-op there (every statement is `if exists`).
--
-- Run it AFTER the code that referenced these tables is deployed — dropping a
-- table out from under a running deploy turns every read into an error.
--
-- Verify afterwards (expect 0 rows):
--   select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in (
--       'salesman_visits','fuel_prices','fuel_price_mappings','fuel_pricing_tiers',
--       'rack_prices','customer_fuel_markups','customer_fuel_tiers',
--       'fuel_purchase_orders','fuel_po_lines','inventory_items','vendor_bills',
--       'bill_vendors','bill_line_map','bill_due_alerts','card_charges',
--       'card_assignments','card_driver_map','plaid_items','quotes',
--       'salesman_visit_requests','business_cards');
-- ==========================================================================

-- ---- Salesman -----------------------------------------------------------
drop table if exists public.salesman_visits cascade;
drop table if exists public.salesman_visit_requests cascade;
drop table if exists public.business_cards cascade;   -- photos keyed to visits
drop function if exists public.notify_salesman_on_new_order() cascade;

-- ---- Quotes (built on inventory + fuel tiers) ---------------------------
drop table if exists public.quotes cascade;
drop sequence if exists public.quotes_seq cascade;
drop function if exists public.notify_on_quote_decision() cascade;

-- ---- Fuel + Fuel PO ------------------------------------------------------
-- NB: eia_diesel_prices is deliberately NOT dropped — it feeds the trucking
-- fuel surcharge, which the app keeps.
drop table if exists public.fuel_po_lines cascade;
drop table if exists public.fuel_purchase_orders cascade;
drop table if exists public.customer_fuel_tiers cascade;
drop table if exists public.customer_fuel_markups cascade;
drop table if exists public.fuel_pricing_tiers cascade;
drop table if exists public.fuel_price_mappings cascade;
drop table if exists public.rack_prices cascade;
drop table if exists public.fuel_prices cascade;

alter table public.businesses drop column if exists fuel_special_pricing;
alter table public.businesses drop column if exists commission_percent;
alter table public.businesses drop column if exists fuel_commission_mode;
alter table public.businesses drop column if exists fuel_commission_per_gallon;

-- ---- Inventory -----------------------------------------------------------
drop table if exists public.inventory_items cascade;
drop function if exists public.low_stock_count() cascade;

-- ---- Bills ---------------------------------------------------------------
drop table if exists public.bill_line_map cascade;
drop table if exists public.bill_due_alerts cascade;
drop table if exists public.bill_vendors cascade;
drop table if exists public.vendor_bills cascade;

-- ---- Card charges + missing receipts -------------------------------------
drop table if exists public.card_assignments cascade;
drop table if exists public.card_driver_map cascade;
drop table if exists public.card_charges cascade;
drop table if exists public.plaid_items cascade;

-- ---- Per-staff notification prefs ---------------------------------------
alter table public.profiles drop column if exists notify_on_visit_request;
alter table public.profiles
  add column if not exists notify_on_work_order boolean not null default true;

-- ---- Visit-reminder cadence settings ------------------------------------
delete from public.app_settings
 where key in ('visit_green_days','visit_yellow_days','visit_orange_days',
               'visit_reminder_start','visit_reminder_interval','visit_admin_alert');

-- ---- Roles: nobody is a 'salesman' any more ------------------------------
-- Move any remaining salesmen to 'office' BEFORE the CHECK constraint is
-- narrowed, or the constraint fails to validate.
update public.profiles set role = 'office' where role = 'salesman';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'driver', 'contractor', 'funder', 'master_admin',
                  'customer', 'office', 'mechanic', 'labor'));

-- ---- Feature flags for tabs that no longer exist -------------------------
delete from public.feature_flags
 where key like 'salesman:%'
    or key in (
      'admin:/admin/sales-log', 'admin:/admin/fuel-prices', 'admin:/admin/fuel-history',
      'admin:/admin/inventory', 'admin:/admin/bills', 'admin:/admin/card-charges',
      'driver:/driver/inventory', 'driver:/salesman/order'
    );
