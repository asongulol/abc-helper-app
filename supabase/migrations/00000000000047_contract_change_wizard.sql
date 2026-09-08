-- ============================================================================
-- 47: contract-change wizard — reason, benefits, re-sign package, pay holds
-- ----------------------------------------------------------------------------
-- docs/CONTRACT-CHANGE-WIZARD-PLAN.md §1 (owner decisions 2026-09-08). Every
-- column the five wizard slices need lands here at once so later slices ship
-- code only:
--
--   contract_versions
--     change_reason / change_note   why this version exists (decision 2); the
--                                   note is admin-only, the label is shown to
--                                   the contractor
--     change_detail                 {"increase": {method, value, from, to, base}}
--                                   so history reads "+5% · 8,000 → 8,400"
--     health_allowance, thirteenth_month, holiday_pay, pto_days_per_year
--                                   benefit terms that ride on the version and
--                                   write through to the worker at countersign
--                                   (decision 6); NULL on legacy rows = unchanged
--     resign_kinds / resign_due_on  the re-sign package (decision 8) and the
--                                   last day of the period after the send
--                                   period (decision 9)
--   workers
--     holiday_pay_eligible, pto_days_per_year   the two new benefit flags,
--                                   records only — Calculate ignores both
--   payments
--     hold_*                        a draft held while the package is unsigned,
--                                   and who lifted it by hand and why
--
-- ADDITIVE per docs/shared-prod-conformance.md: nullable or defaulted columns
-- only; every legacy insert into workers / payments keeps working through the
-- defaults. IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE public.contract_versions
  ADD COLUMN IF NOT EXISTS change_reason     text,
  ADD COLUMN IF NOT EXISTS change_note       text,
  ADD COLUMN IF NOT EXISTS change_detail     jsonb,
  ADD COLUMN IF NOT EXISTS health_allowance  boolean,
  ADD COLUMN IF NOT EXISTS thirteenth_month  boolean,
  ADD COLUMN IF NOT EXISTS holiday_pay       boolean,
  ADD COLUMN IF NOT EXISTS pto_days_per_year integer,
  ADD COLUMN IF NOT EXISTS resign_kinds      public.agreement_kind[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS resign_due_on     date;

DO $$ BEGIN
  ALTER TABLE public.contract_versions
    ADD CONSTRAINT contract_versions_change_reason_check CHECK (
      change_reason IS NULL OR change_reason IN
        ('annual_review', 'cola', 'role_change', 'rehire', 'terms_change', 'other')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.contract_versions
    ADD CONSTRAINT contract_versions_pto_days_nonneg CHECK (pto_days_per_year >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.workers
  ADD COLUMN IF NOT EXISTS holiday_pay_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pto_days_per_year    integer NOT NULL DEFAULT 12;

DO $$ BEGIN
  ALTER TABLE public.workers
    ADD CONSTRAINT workers_pto_days_nonneg CHECK (pto_days_per_year >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS hold_reason      text,
  ADD COLUMN IF NOT EXISTS held_at          timestamptz,
  ADD COLUMN IF NOT EXISTS hold_lifted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS hold_lifted_by   text,
  ADD COLUMN IF NOT EXISTS hold_lifted_note text;

COMMIT;

-- ROLLBACK:
--   alter table payments drop column if exists hold_reason, drop column if exists held_at,
--     drop column if exists hold_lifted_at, drop column if exists hold_lifted_by,
--     drop column if exists hold_lifted_note;
--   alter table workers drop column if exists holiday_pay_eligible,
--     drop column if exists pto_days_per_year;
--   alter table contract_versions drop column if exists change_reason,
--     drop column if exists change_note, drop column if exists change_detail,
--     drop column if exists health_allowance, drop column if exists thirteenth_month,
--     drop column if exists holiday_pay, drop column if exists pto_days_per_year,
--     drop column if exists resign_kinds, drop column if exists resign_due_on;
