-- 0017 — coverage targets (audit/05 §2.3/§4.1, audit/proposals/coverage-gap-detection.md):
--   Expected work per contractor per period, so the Overview can flag a *coverage* gap
--   (expected-but-not-worked) instead of only missing config. Explicit targets here OVERRIDE
--   the existing informational `worker_companies.weekly_hours`, which the app uses as the
--   fallback target when no row exists — so detection works before any target is entered.
--
-- company_id NULL = an employer-wide target (owner-managed); a non-null company scopes it to
-- that client and is manageable by that client's admins. RLS mirrors `rates_admin_all`.

BEGIN;

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

-- At most one OPEN (effective_to IS NULL) target per (worker, company-or-employer, period_kind).
-- COALESCE the nullable company_id to the nil uuid so employer-wide rows collide correctly.
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

-- Admin read/write scoped by company (owners see all; company_id NULL ⇒ owner-only),
-- identical to rates_admin_all.
DROP POLICY IF EXISTS coverage_targets_admin_all ON public.coverage_targets;
CREATE POLICY coverage_targets_admin_all ON public.coverage_targets
  TO authenticated
  USING (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

-- Match the baseline grant convention (RLS is the gate, not the grant).
GRANT ALL ON TABLE public.coverage_targets TO anon;
GRANT ALL ON TABLE public.coverage_targets TO authenticated;
GRANT ALL ON TABLE public.coverage_targets TO service_role;

COMMIT;
