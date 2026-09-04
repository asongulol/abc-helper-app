-- ============================================================================
-- 44: contract_versions — rehire / modify / re-issue an IC agreement
-- ----------------------------------------------------------------------------
-- docs/CONTRACT-VERSIONS-PLAN.md (owner decisions 2026-09-04). A contract is
-- one unit: the signed IC agreement, the worker_companies row and the
-- effective-dated rate move together, and a signed document is never edited
-- in place. Any change to a rendered term is a NEW version the contractor
-- signs and an admin countersigns; countersign is what writes the rate row.
--
-- The existing onboarding_agreements.ic_agreement row + its doc_version='1'
-- signature is read as version 1 for every current worker (no backfill), so
-- rows here start at 2. Signatures keep using onboarding_signatures with
-- doc_version = the version number and doc_sha256 = sha256(rendered_body).
--
-- Three invariants live in the index set, not in app code:
--   * one row per (engagement, version)
--   * one version IN FLIGHT (draft/sent/signed) per engagement
--   * one version OF RECORD (active) per engagement
--
-- RLS: SELECT only, same shape as onboarding_signatures_read — a contractor
-- sees their own rows through my_worker_id(), an admin through
-- admin_can_see_worker(). Both are SECURITY DEFINER helpers, so the policy
-- never reads worker_companies/companies under the contractor role. No write
-- policies: every write goes through a server action on the service client.
--
-- ADDITIVE per docs/shared-prod-conformance.md: one enum, one table, indexes,
-- one policy. Nothing existing is touched. The legacy portal keeps rendering
-- the version-1 row and never sees this table. IDEMPOTENT.
-- ============================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE public.contract_version_status AS ENUM
    ('draft', 'sent', 'signed', 'active', 'superseded', 'ended', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.contract_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id          uuid NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES public.companies(id),
  version            integer NOT NULL CHECK (version >= 2),
  status             public.contract_version_status NOT NULL DEFAULT 'draft',
  -- terms: what renders into the document
  rate_php           numeric(12,2) NOT NULL CHECK (rate_php >= 0),
  period_basis       text NOT NULL DEFAULT 'semi_monthly',
  position           text,
  employment_type    public.contract_type,
  schedule           text,
  hours_per_week     integer,
  start_date         date NOT NULL,                 -- engagement start (rehire: the new one)
  effective_from     date NOT NULL,                 -- when the terms apply to pay
  addendum_type      text,
  addendum_text      text,
  -- lifecycle
  supersedes_id      uuid REFERENCES public.contract_versions(id),  -- NULL when superseding the v1 read-through
  ended_on           date,                          -- stamped by termination / supersede
  rendered_body      text,                          -- frozen at send
  doc_sha256         text,                          -- sha256(rendered_body), copied onto the signature
  sent_at            timestamptz,
  signed_at          timestamptz,
  countersigned_at   timestamptz,
  countersigned_by   uuid,
  countersigned_name text,
  voided_at          timestamptz,
  void_reason        text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_versions_effective_after_start CHECK (effective_from >= start_date)
);
ALTER TABLE public.contract_versions OWNER TO postgres;

CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_engagement_version_uniq
  ON public.contract_versions (worker_id, company_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_one_in_flight
  ON public.contract_versions (worker_id, company_id)
  WHERE status IN ('draft', 'sent', 'signed');

CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_one_active
  ON public.contract_versions (worker_id, company_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS contract_versions_worker_idx ON public.contract_versions (worker_id);

ALTER TABLE public.contract_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_versions_read ON public.contract_versions;
CREATE POLICY contract_versions_read ON public.contract_versions
  FOR SELECT TO authenticated
  USING (worker_id = public.my_worker_id() OR public.admin_can_see_worker(worker_id));

-- Match the baseline grant convention (RLS is the gate, not the grant).
GRANT ALL ON TABLE public.contract_versions TO anon;
GRANT ALL ON TABLE public.contract_versions TO authenticated;
GRANT ALL ON TABLE public.contract_versions TO service_role;

COMMIT;

-- ROLLBACK:
--   drop table if exists public.contract_versions;
--   drop type if exists public.contract_version_status;
