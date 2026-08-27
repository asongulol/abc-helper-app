-- ============================================================================
-- 40: workers.health_allowance_date — editable annual HA pay date
-- ----------------------------------------------------------------------------
-- The ₱20,000 health allowance pays in the ONE period containing the hire
-- anniversary (src/lib/pay/allowances.ts). The owner needs to move that date
-- for some contractors, so this column overrides WHICH month/day the payment
-- lands on. NULL (the default, and every existing row) keeps the hire
-- anniversary — behavior unchanged. Only the month/day are read; the year is
-- whatever the admin picked in the date input and is ignored. The 180-day
-- eligibility gate stays keyed to hire_date.
-- Additive + nullable: safe on the shared prod DB before the code deploys.
-- ============================================================================
alter table public.workers
  add column if not exists health_allowance_date date;

comment on column public.workers.health_allowance_date is
  'Annual health-allowance pay date override. NULL = hire anniversary. Only month/day are used (year ignored); 180-day eligibility still runs off hire_date.';
