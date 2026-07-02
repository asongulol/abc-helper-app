-- Off-cycle salaried catch-up hours: extend the off_cycle_pay_items basis CHECK
-- with 'salaried_hours' — FT/PT leftover hours from an already-locked/paid regular
-- period, paid as a catch-up line on a later run.
--
-- Row shape for the new basis: session_id null, work_date = the ORIGINAL period's
-- period_end (so the existing off_cycle_manual_date_uniq partial unique index
-- dedups one catch-up per worker per original period), units = leftover hours,
-- rate_php = the original period rate, amount_php = engine-diff snapshot
-- (rate × (min((paid+leftover)/expected, 1) − min(paid/expected, 1))) — never
-- re-priced, like every other ledger row.
--
-- Deliberately NOT feeding perHourDatesByWorker (that set is per_hour-only), so a
-- future unlock+recalc of the original period is not corrupted by date exclusion.
--
-- ADDITIVE + IDEMPOTENT. Do NOT `db push` to shared prod — apply via the SQL
-- Editor / MCP, then record "00000000000026" in supabase/prod-applied.json.

alter table public.off_cycle_pay_items
  drop constraint if exists off_cycle_pay_items_basis_check;
alter table public.off_cycle_pay_items
  add constraint off_cycle_pay_items_basis_check
  check (basis in ('per_session', 'per_hour', 'salaried_hours'));

-- ROLLBACK: delete rows with basis='salaried_hours', then re-add the
-- two-value check ('per_session', 'per_hour').
