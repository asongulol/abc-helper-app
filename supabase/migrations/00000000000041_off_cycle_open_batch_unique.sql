-- ============================================================================
-- "One open off-cycle batch per employer" — enforce it, don't just state it
-- ----------------------------------------------------------------------------
-- Migration 24 documented this invariant in a comment and backed the
-- find-or-create lookup with a NON-unique partial index, so two concurrent
-- findOrCreateOffCycleBatch calls could both pass the read and insert two open
-- batches (read-then-write race). Make the partial index UNIQUE: the lookup
-- keeps its index, and the losing insert now fails 23505 — the app catches it
-- and adopts the winner's batch (src/db/queries/payroll.ts).
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard (disjoint
-- history); see audit/off-cycle-open-batch-unique-2026-08-27.sql. ADDITIVE +
-- IDEMPOTENT. Pre-flight 2026-08-27: prod has ZERO open off-cycle batches, so
-- the unique index applies clean.
-- ============================================================================

drop index if exists public.pay_periods_off_cycle_open_idx;

create unique index if not exists pay_periods_off_cycle_open_uniq
  on public.pay_periods (company_id)
  where kind = 'off_cycle' and state = 'open';

-- ROLLBACK:
--   drop index if exists public.pay_periods_off_cycle_open_uniq;
--   create index if not exists pay_periods_off_cycle_open_idx
--     on public.pay_periods (company_id)
--     where kind = 'off_cycle' and state = 'open';
