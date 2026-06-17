-- Cutover rename: payments.deduction_php  ->  payments.shortfall_php
--
-- Why: the legacy column was named "deduction_php" but it stores the performance
-- shortfall (rate - gross), which is INFORMATIONAL and is never subtracted from
-- net_php. The misleading name surfaced to contractors as a "Deduction" line. The
-- new app standardized on "shortfall_php".
--
-- Decision: hard rename in prod (no backward-compat shim). Rolling back to the old
-- app requires reversing this rename first — instant rollback for this one column
-- is intentionally given up.
--
-- Divergence note: the 0001 baseline was edited in-place to already use
-- shortfall_php, so a freshly-reset dev/local DB has the new name, while prod still
-- has the legacy deduction_php. Both arms below are GUARDED so this migration is a
-- safe no-op anywhere the column is already named shortfall_php, and performs the
-- rename only where the legacy column still exists.
--
-- Scope: a prod dependency scan (pg_proc / pg_views / generated columns) found the
-- column referenced by name in exactly one object — the payments_lock_enforce
-- trigger function. ALTER TABLE ... RENAME COLUMN auto-rewrites dependent views,
-- but plpgsql bodies are stored as text and are NOT auto-updated, so that function
-- is re-created below to point at shortfall_php after the rename.

BEGIN;

-- 1) Rename the physical column (guarded; no-op if already renamed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
      AND column_name = 'deduction_php'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
      AND column_name = 'shortfall_php'
  ) THEN
    ALTER TABLE public.payments RENAME COLUMN deduction_php TO shortfall_php;
  END IF;
END
$$;

-- 2) Document the column (idempotent).
COMMENT ON COLUMN public.payments.shortfall_php IS
  'Performance shortfall (rate - gross). INFORMATIONAL ONLY — never subtracted from net_php. Renamed from the legacy "deduction_php", whose name wrongly implied money was withheld. Real, subtracted deductions live in misc_items (kind=deduction).';

-- 3) Re-point the lock-enforcement trigger function at shortfall_php. plpgsql is
--    late-bound, so this is safe regardless of rename ordering; CREATE OR REPLACE
--    is idempotent and preserves the existing owner on prod.
CREATE OR REPLACE FUNCTION public.payments_lock_enforce() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $fn$
declare
  changed_cols text[] := '{}';
begin
  if old.wise_locked_at is null then
    return new;
  end if;
  if new.company_id           is distinct from old.company_id           then changed_cols := array_append(changed_cols,'company_id'); end if;
  if new.pay_period_id        is distinct from old.pay_period_id        then changed_cols := array_append(changed_cols,'pay_period_id'); end if;
  if new.worker_id            is distinct from old.worker_id            then changed_cols := array_append(changed_cols,'worker_id'); end if;
  if new.expected_hours       is distinct from old.expected_hours       then changed_cols := array_append(changed_cols,'expected_hours'); end if;
  if new.worked_hours         is distinct from old.worked_hours         then changed_cols := array_append(changed_cols,'worked_hours'); end if;
  if new.performance_ratio    is distinct from old.performance_ratio    then changed_cols := array_append(changed_cols,'performance_ratio'); end if;
  if new.rate_php             is distinct from old.rate_php             then changed_cols := array_append(changed_cols,'rate_php'); end if;
  if new.gross_php            is distinct from old.gross_php            then changed_cols := array_append(changed_cols,'gross_php'); end if;
  if new.health_allowance_php is distinct from old.health_allowance_php then changed_cols := array_append(changed_cols,'health_allowance_php'); end if;
  if new.pdd_lunch_php        is distinct from old.pdd_lunch_php        then changed_cols := array_append(changed_cols,'pdd_lunch_php'); end if;
  if new.bonus_php            is distinct from old.bonus_php            then changed_cols := array_append(changed_cols,'bonus_php'); end if;
  if new.thirteenth_month_php is distinct from old.thirteenth_month_php then changed_cols := array_append(changed_cols,'thirteenth_month_php'); end if;
  if new.shortfall_php        is distinct from old.shortfall_php        then changed_cols := array_append(changed_cols,'shortfall_php'); end if;
  if new.net_php              is distinct from old.net_php              then changed_cols := array_append(changed_cols,'net_php'); end if;
  if new.original_net_php     is distinct from old.original_net_php     then changed_cols := array_append(changed_cols,'original_net_php'); end if;
  if new.payout_currency      is distinct from old.payout_currency      then changed_cols := array_append(changed_cols,'payout_currency'); end if;
  if new.payout_amount        is distinct from old.payout_amount        then changed_cols := array_append(changed_cols,'payout_amount'); end if;
  if new.payout_method        is distinct from old.payout_method        then changed_cols := array_append(changed_cols,'payout_method'); end if;
  if new.misc_items           is distinct from old.misc_items           then changed_cols := array_append(changed_cols,'misc_items'); end if;
  if array_length(changed_cols, 1) is not null then
    raise exception
      'payment % is locked (wise_locked_at=%); cannot change protected column(s): %',
      old.id, old.wise_locked_at, array_to_string(changed_cols, ', ')
      using errcode = 'check_violation',
            hint = 'Unlock the row first (clears wise_locked_at), then edit.';
  end if;
  return new;
end;
$fn$;

COMMIT;
