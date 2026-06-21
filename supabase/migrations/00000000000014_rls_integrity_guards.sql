-- 0014 — RLS tenant-isolation fixes + payroll integrity guards.
--
-- Closes the highest-risk findings from the read-only audit (audit/00-summary.md §6,
-- audit/04-database.md §7). All changes are ADDITIVE and cutover-safe:
--   * value-domain CHECKs are added NOT VALID, so they guard every new INSERT/UPDATE
--     but never fail the cutover on pre-existing rows (run VALIDATE CONSTRAINT later,
--     after a data review, to also cover historical rows);
--   * the new unique index is created only when the data is already clean (a dirty
--     prod raises a WARNING and is left untouched rather than aborting the migration).
--
-- 1. pay_periods: contractor read was tenant-blind (any onboarded contractor could
--    read EVERY company's pay-period schedule). Re-scope to "periods the contractor
--    actually has a payment in" — the only thing the portal payslip join needs.
-- 2. audit_log: RLS was `FOR ALL` (a scoped admin could UPDATE/DELETE their company's
--    trail at the SQL level; only the 0005 trigger stopped it). Split into SELECT +
--    INSERT, mirroring logEvent()'s insert path, so the trail is RLS-immutable too.
-- 3. Money / quantity domain CHECKs on payments, rates, invoices, invoice_lines,
--    worker_companies (no negatives; performance_ratio within [0,5]).
-- 4. invoices.status constrained to the 4 known states (uniqueness + the invoice_no
--    allocator both rely on `status <> 'void'`; a typo silently bypassed both).
-- 5. invoices.period_end >= period_start (parity with pay_periods/rates).
-- 6. rates: at most one OPEN rate (effective_end IS NULL) per (worker, company) — the
--    invariant the 3-step upsert already maintains; enforce it so "current rate" is
--    never ambiguous.
-- 7. payments.misc_items: validate element shape (financially material; was only
--    checked for `jsonb_typeof = array`). Mirrors MiscItemSchema (kind required
--    non-empty string; amount/hours optional number|string|null).

BEGIN;

-- 1. pay_periods contractor read — tenant-scoped via a SECURITY DEFINER helper
--    (mirrors the existing my_worker_id()/is_onboarded() helper pattern; avoids
--    recursive RLS on the payments subquery).
CREATE OR REPLACE FUNCTION public.worker_has_payment_in_period(pid uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
    select exists (
      select 1 from payments p
      where p.pay_period_id = pid
        and p.worker_id = my_worker_id()
    );
$$;
ALTER FUNCTION public.worker_has_payment_in_period(uuid) OWNER TO postgres;

DROP POLICY IF EXISTS "pay_periods_contractor_read" ON public.pay_periods;
CREATE POLICY "pay_periods_contractor_read" ON public.pay_periods
  FOR SELECT TO authenticated
  USING (
    (select public.is_onboarded())
    and public.worker_has_payment_in_period(id)
  );

-- 2. audit_log — replace `FOR ALL` with SELECT + INSERT (no UPDATE/DELETE at RLS level).
--    Same predicate as before, so the AuditLog screen still reads and logEvent() still
--    inserts; the only capability removed is the (unused) admin mutate/delete path.
DROP POLICY IF EXISTS "audit_log_admin_all" ON public.audit_log;
DROP POLICY IF EXISTS "audit_log_admin_read" ON public.audit_log;
DROP POLICY IF EXISTS "audit_log_admin_insert" ON public.audit_log;
CREATE POLICY "audit_log_admin_read" ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.is_company_admin(company_id));
CREATE POLICY "audit_log_admin_insert" ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

-- 3–5. Value-domain CHECKs (NOT VALID — guard new writes, don't touch legacy rows).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amounts_nonneg' AND conrelid = 'public.payments'::regclass) THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_amounts_nonneg CHECK (
      gross_php >= 0 AND health_allowance_php >= 0 AND thirteenth_month_php >= 0
      AND shortfall_php >= 0 AND pdd_lunch_php >= 0 AND bonus_php >= 0
      AND (rate_php IS NULL OR rate_php >= 0)
      AND (payout_amount IS NULL OR payout_amount >= 0)
      AND (worked_hours IS NULL OR worked_hours >= 0)
      AND (expected_hours IS NULL OR expected_hours >= 0)
      AND (performance_ratio IS NULL OR (performance_ratio >= 0 AND performance_ratio <= 5))
      -- net_php deliberately unconstrained: misc deductions can in principle drive it
      -- below the additive components; do not assume non-negative here.
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rates_amount_nonneg' AND conrelid = 'public.rates'::regclass) THEN
    ALTER TABLE public.rates ADD CONSTRAINT rates_amount_nonneg CHECK (amount_php >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_amounts_nonneg' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_amounts_nonneg CHECK (
      subtotal_usd >= 0 AND total_usd >= 0 AND markup_pct >= 0
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_check' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check CHECK (
      status IN ('draft', 'sent', 'paid', 'void')
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_period_order' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_period_order CHECK (period_end >= period_start) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_amounts_nonneg' AND conrelid = 'public.invoice_lines'::regclass) THEN
    ALTER TABLE public.invoice_lines ADD CONSTRAINT invoice_lines_amounts_nonneg CHECK (
      worked_hours >= 0 AND bill_rate_usd >= 0 AND amount_usd >= 0
      AND (sessions_count IS NULL OR sessions_count >= 0)
      AND (session_rate_usd IS NULL OR session_rate_usd >= 0)
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_companies_rates_nonneg' AND conrelid = 'public.worker_companies'::regclass) THEN
    ALTER TABLE public.worker_companies ADD CONSTRAINT worker_companies_rates_nonneg CHECK (
      (bill_rate_usd IS NULL OR bill_rate_usd >= 0)
      AND (session_rate_usd IS NULL OR session_rate_usd >= 0)
    ) NOT VALID;
  END IF;
END $$;

-- 6. rates: enforce one OPEN rate per (worker, company) — the invariant the 3-step
--    upsert (docs/money-core-spec.md §10) already maintains. First repair any existing
--    violations PAY-NEUTRALLY, then add the partial unique index. (After the index
--    exists, seed.sql's `on conflict do nothing` rate insert becomes idempotent too.)
--
--    R1 — close superseded older open rates (same worker/company, earlier
--    effective_start) by ending them at the latest open effective_start in the group.
--    resolveRate() already returns the latest-effective_start candidate, so for every
--    period this changes NO resolved rate / computed pay; it only removes the redundant
--    earlier rows from the "open" set.
UPDATE public.rates r
SET effective_end = grp.max_start
FROM (
  SELECT worker_id, company_id, max(effective_start) AS max_start
  FROM public.rates
  WHERE effective_end IS NULL
  GROUP BY worker_id, company_id
  HAVING count(*) > 1
) grp
WHERE r.effective_end IS NULL
  AND r.worker_id = grp.worker_id
  AND r.company_id = grp.company_id
  AND r.effective_start < grp.max_start;

--    R2 — collapse exact-duplicate open rates (same worker/company/effective_start AND
--    identical amount_php — e.g. a seed/import double-insert), keeping the oldest by
--    (created_at, id). Identical rows ⇒ pay-neutral. Same-date rows with DIFFERENT
--    amounts are a genuine conflict, deliberately left untouched for human review (the
--    guard below then skips + warns instead of guessing which amount is current).
DELETE FROM public.rates r
USING (
  SELECT id, row_number() OVER (
    PARTITION BY worker_id, company_id, effective_start, amount_php
    ORDER BY created_at, id
  ) AS rn
  FROM public.rates
  WHERE effective_end IS NULL
) dup
WHERE r.id = dup.id AND dup.rn > 1;

--    Add the partial unique index — guarded: if a genuine (same-date, different-amount)
--    conflict remains, warn and skip rather than abort the migration / cutover.
DO $$
DECLARE dup_pairs int;
BEGIN
  SELECT count(*) INTO dup_pairs FROM (
    SELECT worker_id, company_id FROM public.rates
    WHERE effective_end IS NULL
    GROUP BY worker_id, company_id HAVING count(*) > 1
  ) d;

  IF dup_pairs = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS rates_one_open_per_worker_company
      ON public.rates (worker_id, company_id) WHERE effective_end IS NULL;
  ELSE
    RAISE WARNING 'rates_one_open_per_worker_company NOT created: % (worker, company) pair(s) still have multiple open rates with DIFFERING amounts; resolve manually, then add: CREATE UNIQUE INDEX rates_one_open_per_worker_company ON public.rates (worker_id, company_id) WHERE effective_end IS NULL;', dup_pairs;
  END IF;
END $$;

-- 7. payments.misc_items element-shape validation (mirrors MiscItemSchema).
CREATE OR REPLACE FUNCTION public.payments_misc_items_ok(items jsonb)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path TO 'public'
  AS $$
    select jsonb_typeof(items) = 'array'
       and not exists (
         select 1
         from jsonb_array_elements(items) as e
         where jsonb_typeof(e) <> 'object'
            or not (e ? 'kind')
            or jsonb_typeof(e -> 'kind') <> 'string'
            or length(btrim(e ->> 'kind')) = 0
            or (e ? 'amount' and jsonb_typeof(e -> 'amount') not in ('number', 'string', 'null'))
            or (e ? 'hours'  and jsonb_typeof(e -> 'hours')  not in ('number', 'string', 'null'))
       );
$$;
ALTER FUNCTION public.payments_misc_items_ok(jsonb) OWNER TO postgres;

-- Replace the array-only check with the comprehensive one (subsumes the array test).
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_misc_items_array;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_misc_items_valid' AND conrelid = 'public.payments'::regclass) THEN
    ALTER TABLE public.payments ADD CONSTRAINT payments_misc_items_valid CHECK (public.payments_misc_items_ok(misc_items)) NOT VALID;
  END IF;
END $$;

COMMIT;
