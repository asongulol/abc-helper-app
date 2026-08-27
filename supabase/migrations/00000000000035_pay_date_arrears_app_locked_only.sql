-- ============================================================================
-- Narrow migration 33: only a period THIS APP locked can carry the RP-03 date
-- ----------------------------------------------------------------------------
-- 33 corrects `pay_date` on periods locked before the RP-03 fix, keying on the
-- bug's signature `pay_date = period_end`. Measured against prod before applying
-- it, that predicate matched 16 rows — and 14 of them are not the bug:
--
--   * 14 rows are IMPORTED HISTORY (bulk-created 2026-06-04, `locked_at` null)
--     from before the arrears schedule existed. Their payments.paid_at sits AT
--     or just before period_end — every one of the 23 rows in 2024-11-01→11-15
--     was paid on 11-15 — so period_end IS their true pay date. 33 would have
--     post-dated real, already-paid runs by two weeks on payslips, statements,
--     reports and the Wise matcher anchor.
--   * 2 rows are the genuine bug: 2026-06-01→06-15 and 2026-06-16→06-30, both
--     locked by this app, with modal paid_at 06-29 / 07-13 against arrears dates
--     of 06-30 / 07-15 — paid a day or two early, exactly as expected.
--
-- RP-03 lived in `lockPeriod`, so `locked_at is not null` is precisely the set
-- of periods that can carry the value it wrote. PROD RAN 33 WITH THAT EXTRA
-- PREDICATE (2 rows changed) — 33's committed text is retained unedited only
-- because migration history is append-only.
--
-- This migration is therefore a NO-OP on prod, and repairs any database where
-- 33 already ran in its wider form: a `paid` period that this app never locked
-- is imported history, and its pay date is its period end. An OPEN period is
-- excluded — it legitimately carries the arrears date with `locked_at` null,
-- which is what 33's expression produces, and resetting it would reintroduce
-- the very bug being fixed.
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard/MCP (disjoint
-- history), then recorded in supabase/prod-applied.json. IDEMPOTENT.
-- ============================================================================

update public.pay_periods
set pay_date = period_end
where coalesce(kind, 'regular') <> 'off_cycle'
  and locked_at is null
  and state = 'paid'
  and pay_date is distinct from period_end
  and pay_date = case
      when extract(day from period_start) <= 15
        then (date_trunc('month', period_start) + interval '1 month' - interval '1 day')::date
        else (date_trunc('month', period_start) + interval '1 month' + interval '14 days')::date
    end;

-- ROLLBACK: none — this restores the value 33 overwrote, which for an imported
-- period is recomputable as period_end.
