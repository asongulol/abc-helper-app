-- ============================================================================
-- abc-helper-app → shared prod: ADDITIVE conformance (apply MANUALLY)
-- ============================================================================
-- Target project: cgsidolrauzsowqlllsz  ("ABC HR-Payroll App")
--
-- HOW TO APPLY:  paste into the Supabase Dashboard → SQL Editor → Run.
--   • Do NOT run via `supabase db push` / the migration CLI (prod's migration
--     history is disjoint from this repo's — push would try to re-baseline).
--   • Run the whole file as-is. Do NOT append a `rollback;` (a stray rollback
--     once silently undid a prod change here — see the incident notes).
--   • Re-runnable: every statement is idempotent (IF NOT EXISTS / DROP ... IF
--     EXISTS), so applying twice is a no-op.
--
-- WHY THIS IS SAFE (the shared DB still serves 3 live apps):
--   These objects are ADDITIVE — a NEW table + NEW nullable columns that the
--   originals never reference. Verified 2026-06-23 by grepping all three live
--   apps (wis-hubstaff, admin-redesign, mobile): **0** references to
--   coverage_targets, amount_received_usd, payment_ref, received_on, revealed_at.
--   Nothing existing is renamed/dropped/retyped, so the live apps are untouched.
--
-- WHAT THIS DOES NOT DO (deliberately out of scope — needs separate review):
--   abc-helper-app's worker-tools "one-time reveal" flow also depends on RPCs
--   (reveal_worker_tools, my_tools_pending) that prod LACKS, and whose prod
--   namesakes (set_worker_tools / get_my_tools) have DIFFERENT signatures the
--   originals rely on. Replacing those functions could break the live apps, so
--   only the additive `worker_tools.revealed_at` COLUMN is added here. The
--   function reconciliation is a separate, per-function task.
-- ============================================================================

BEGIN;

-- ── 1) coverage_targets ─────────────────────────────────────────────────────
-- abc-helper-app's coverage-gap detection (repo migration 017). New table the
-- originals don't have; RLS mirrors rates_admin_all via is_company_admin (which
-- prod already defines). Rollback: DROP TABLE public.coverage_targets;
CREATE TABLE IF NOT EXISTS public.coverage_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       uuid NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES public.companies(id) ON DELETE CASCADE,  -- NULL = employer-wide
  period_kind     text NOT NULL DEFAULT 'semi_monthly'
                    CHECK (period_kind IN ('weekly', 'semi_monthly')),
  target_hours    numeric CHECK (target_hours IS NULL OR target_hours >= 0),
  target_sessions integer CHECK (target_sessions IS NULL OR target_sessions >= 0),
  effective_from  date NOT NULL,
  effective_to    date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.coverage_targets OWNER TO postgres;

CREATE UNIQUE INDEX IF NOT EXISTS coverage_targets_one_open
  ON public.coverage_targets (
    worker_id,
    COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_kind
  )
  WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS coverage_targets_worker_idx ON public.coverage_targets (worker_id);
CREATE INDEX IF NOT EXISTS coverage_targets_company_idx ON public.coverage_targets (company_id);

ALTER TABLE public.coverage_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coverage_targets_admin_all ON public.coverage_targets;
CREATE POLICY coverage_targets_admin_all ON public.coverage_targets
  TO authenticated
  USING (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));
GRANT ALL ON TABLE public.coverage_targets TO anon;
GRANT ALL ON TABLE public.coverage_targets TO authenticated;
GRANT ALL ON TABLE public.coverage_targets TO service_role;

-- ── 2) invoices: AR receipt-tracking columns ────────────────────────────────
-- abc-helper-app records partial/at receipt against an invoice (repo mig 015).
-- New nullable columns. Rollback: ALTER TABLE public.invoices DROP COLUMN ...;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_received_usd numeric(14,2);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS received_on date;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_ref text;

-- ── 3) worker_tools.revealed_at ─────────────────────────────────────────────
-- One-time-reveal timestamp abc-helper-app reads (repo baseline). New nullable
-- column only (NOT the reveal functions — see header). Rollback:
-- ALTER TABLE public.worker_tools DROP COLUMN revealed_at;
ALTER TABLE public.worker_tools ADD COLUMN IF NOT EXISTS revealed_at timestamp with time zone;

COMMIT;

-- ── Verify (optional; run after COMMIT) ─────────────────────────────────────
-- SELECT to_regclass('public.coverage_targets')                                          AS coverage_targets_exists;  -- expect non-null
-- SELECT count(*) FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='invoices'
--     AND column_name IN ('amount_received_usd','received_on','payment_ref');             -- expect 3
-- SELECT count(*) FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='worker_tools' AND column_name='revealed_at';  -- expect 1
