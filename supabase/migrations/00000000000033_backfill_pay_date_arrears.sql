-- ============================================================================
-- One-off data fix: pay_date on periods locked before the RP-03 fix
-- ----------------------------------------------------------------------------
-- lockPeriod used to overwrite pay_periods.pay_date with period_end — a date
-- BEFORE the payment window even opens. Payroll runs a half-month in ARREARS:
-- days 1–15 are paid at the END of the same month, days 16–EOM on the 15th of
-- the next month. The code fix (RP-03) stopped the write, and an OPEN period
-- self-heals on its next recalculate (upsertOpenPeriod rewrites pay_date from
-- periodFor().payDate) — but a LOCKED or PAID period never recalculates again,
-- so its wrong date is frozen into payslips, statements, reports and the Wise
-- matcher anchor. This corrects those rows.
--
-- Only rows that carry the exact wrong value are touched:
--   * pay_date = period_end  — the bug's signature. It can never be a legal pay
--     date: for days 1–15 the correct date is month-end (period_end is the 15th),
--     for days 16–EOM it is the 15th of the NEXT month (period_end is month-end).
--     So this can never clobber a deliberately-set date.
--   * pay_date is null       — legacy-seeded periods that never had one.
-- Re-running is a no-op: after the update neither predicate matches.
--
-- kind = 'off_cycle' is EXCLUDED. An off-cycle batch legitimately sets
-- period_start = period_end = pay_date ("pay now, off the schedule"), which
-- would otherwise look exactly like the bug.
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

-- ROLLBACK: none — this restores the documented arrears rule. The prior values
-- were period_end (recomputable) or null.
