-- ============================================================================
-- Company-level observed holidays config
-- ----------------------------------------------------------------------------
-- Moves the Observed Holidays editor off per-browser localStorage onto the
-- employer company, so a custom holiday set is shared across admins AND — the
-- load-bearing part — actually reaches the SERVER-SIDE payroll calc.
-- expected-hours previously always used defaultHolidays() because localStorage
-- is unreachable on the server, so custom holidays never affected pay.
--
-- Shape: { "<year>": [ { "date": "YYYY-MM-DD", "name": "..." }, ... ], ... }
-- A present year key is authoritative (its array is the full effective set for
-- that year, including an explicit empty array = "no holidays this year"); a
-- missing year falls back to the standard defaults in code
-- (resolveHolidaysForRange).
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard (disjoint
-- history). ADDITIVE + IDEMPOTENT. No RLS change (companies already has policies).
-- ============================================================================

alter table public.companies
  add column if not exists holidays_config jsonb not null default '{}'::jsonb;

comment on column public.companies.holidays_config is
  'Per-year observed-holidays override for payroll expected-hours: { "<year>": [{date,name}] }. A missing year falls back to code defaults.';

-- ROLLBACK:
--   alter table public.companies drop column if exists holidays_config;
