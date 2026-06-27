-- ============================================================================
-- Dedicated off-cycle pay batches
-- ----------------------------------------------------------------------------
-- A `kind` marker on pay_periods so an off-cycle CATCH-UP batch — per-session
-- sessions whose own pay period is already locked/paid — can be a SEPARATE
-- payroll run, calculated/locked/paid on its own.
--
--   'regular'   = the normal semi-monthly periods (unchanged behaviour),
--   'off_cycle' = a catch-up batch whose pay comes ONLY from off_cycle_pay_items
--                 (the app guards the regular calc against this kind and builds
--                 the batch's rows from the ledger via recomputeWorkerDraft's
--                 off-cycle-only path).
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard (disjoint
-- history). ADDITIVE + IDEMPOTENT.
-- ============================================================================

alter table public.pay_periods
  add column if not exists kind text not null default 'regular'
  check (kind in ('regular', 'off_cycle'));

comment on column public.pay_periods.kind is
  'regular = normal semi-monthly period; off_cycle = a catch-up batch paid only from off_cycle_pay_items.';

-- One open off-cycle batch per employer at a time (find-or-create lookup).
create index if not exists pay_periods_off_cycle_open_idx
  on public.pay_periods (company_id)
  where kind = 'off_cycle' and state = 'open';

-- ROLLBACK:
--   drop index if exists public.pay_periods_off_cycle_open_idx;
--   alter table public.pay_periods drop column if exists kind;
