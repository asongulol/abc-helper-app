-- ============================================================================
-- pay_periods remembers the Calculate that produced its rows
-- ----------------------------------------------------------------------------
-- Two things were computed once, used to write every payment row, and then
-- thrown away — so anything that later rebuilt ONE row had to guess:
--
--  include_ha / include_13
--    RP-20: recomputeWorkerDraft (adding/removing an off-cycle or catch-up item)
--    hardcoded `includeHealthAllowance: true, includeThirteenth: false`. A batch
--    calculated with HA off, or with the year-end 13th-month accrual on, had that
--    one worker rebuilt under DIFFERENT toggles than the rest of the run.
--    Defaults match the old hardcode, so pre-existing periods rebuild exactly as
--    they do today.
--
--  prior_payments
--    RP-23: the recalc UNDO snapshot round-tripped through the browser —
--    calculatePeriodDraft returned every payments row and restorePaymentsSnapshot
--    inserted back whatever came in, money columns / status / paid_at verbatim
--    (RestoreSnapshotSchema was `z.array(z.record(z.string(), z.unknown()))`).
--    Storing it server-side removes the trust boundary entirely: the client now
--    sends only the period id.
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard/MCP (disjoint
-- history), then recorded in supabase/prod-applied.json. ADDITIVE + IDEMPOTENT.
-- ============================================================================

alter table public.pay_periods
  add column if not exists include_ha boolean not null default true,
  add column if not exists include_13 boolean not null default false,
  add column if not exists prior_payments jsonb;

comment on column public.pay_periods.include_ha is
  'Health-allowance toggle used by the Calculate that built this period''s rows; replayed when a single row is rebuilt (RP-20).';
comment on column public.pay_periods.include_13 is
  '13th-month accrual toggle used by the Calculate that built this period''s rows; replayed when a single row is rebuilt (RP-20).';
comment on column public.pay_periods.prior_payments is
  'Server-held snapshot of this period''s payments rows as they were BEFORE the last recalculate — the source for the Undo (RP-23). Null = nothing to undo.';

-- ROLLBACK:
--   alter table public.pay_periods drop column if exists prior_payments;
--   alter table public.pay_periods drop column if exists include_13;
--   alter table public.pay_periods drop column if exists include_ha;
