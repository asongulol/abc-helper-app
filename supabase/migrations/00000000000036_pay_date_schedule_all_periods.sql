-- ============================================================================
-- pay_date is the SCHEDULE, not a record of when the money moved
-- ----------------------------------------------------------------------------
-- Supersedes migration 35, which was written on a wrong reading of the column.
--
-- 35 assumed that a paid period whose `payments.paid_at` landed at or just
-- before `period_end` must have been SCHEDULED for period_end, and restored
-- period_end on those rows. That inverted the column's meaning. Per the owner:
--
--   pay_date is the deadline — payroll is paid AT THE LATEST on the scheduled
--   date, and in practice almost always earlier, because the payment is made
--   by hand.
--
-- So paying early is the normal case and says nothing about the schedule. Every
-- regular period's pay_date is the semi-monthly arrears date: days 1–15 → the
-- end of that same month, days 16–EOM → the 15th of the next month. A pay_date
-- equal to period_end is always wrong — the window would close on the day it is
-- due — which is what RP-03's lockPeriod write produced and what legacy-seeded
-- rows carry.
--
-- 35 did more than narrow, and this is the repair. Its predicate selected rows
-- whose pay_date ALREADY equalled the arrears date and set them to period_end —
-- i.e. it targeted precisely the periods that were correct. Prod went from 16
-- wrong rows to 49 (16 + 33 clobbered). Any database that ran 35 has the same
-- damage.
--
-- This applies 33's rule to every regular period again. On prod that is those 49
-- rows (all `paid`, pay_date = period_end, 2024-02-01 → 2026-04-01); the 2
-- periods 33 already corrected no longer match, and OPEN periods were never
-- touched by 35 (it required state='paid'). Re-running is a no-op: after the
-- update neither predicate matches.
--
-- kind = 'off_cycle' stays EXCLUDED. An off-cycle batch legitimately sets
-- period_start = period_end = pay_date ("pay now, off the schedule").
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard/MCP (disjoint
-- history), then recorded in supabase/prod-applied.json. IDEMPOTENT.
-- ============================================================================

update public.pay_periods
set pay_date = case
    when extract(day from period_start) <= 15
      -- days 1–15 → last day of that same month
      then (date_trunc('month', period_start) + interval '1 month' - interval '1 day')::date
      -- days 16–EOM → the 15th of the next month
      else (date_trunc('month', period_start) + interval '1 month' + interval '14 days')::date
  end
where coalesce(kind, 'regular') <> 'off_cycle'
  and (pay_date is null or pay_date = period_end);

-- ROLLBACK: none — this restores the documented arrears schedule. The prior
-- values were period_end (recomputable) or null.
