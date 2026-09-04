-- ============================================================================
-- 46: contract_versions.notice_days — per-position termination notice
-- ----------------------------------------------------------------------------
-- Owner decision 2026-09-04 (docs/CONTRACT-VERSIONS-PLAN.md §7): clause values
-- that vary by position are merge tokens on the version, never edits to a
-- signed body and never per-position templates. First token: the Section 11.1
-- termination notice, rendered as {{notice_days}}. Default 15 = what the
-- template said in words before this migration, so every version 1 agreement
-- (the legacy read-through, the onboarding sign page) reads exactly as before.
--
-- The UPDATE swaps the hard-coded "fifteen (15)" for the token in the live IC
-- agreement body. The number is matched loosely — the live row read
-- "fifteen (30)" by the time this ran, an edit made in the template editor the
-- same afternoon — and the guard is the same pattern, so it is a no-op wherever
-- the phrase is absent (a fresh local seed never had it).
--
-- ADDITIVE per docs/shared-prod-conformance.md: one nullable-default column,
-- one CHECK, one guarded data edit. The legacy portal merges this template too
-- but is retired for signing (301 to the app since 2026-08-29). IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE public.contract_versions
  ADD COLUMN IF NOT EXISTS notice_days integer NOT NULL DEFAULT 15;

DO $$ BEGIN
  ALTER TABLE public.contract_versions
    ADD CONSTRAINT contract_versions_notice_days_positive CHECK (notice_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE public.agreement_templates
SET body = regexp_replace(
  body,
  'fifteen \(\d+\) calendar days'' prior written notice',
  '{{notice_days}} calendar days'' prior written notice'
)
WHERE kind = 'ic_agreement'
  AND body ~ 'fifteen \(\d+\) calendar days'' prior written notice';

COMMIT;

-- ROLLBACK:
--   update agreement_templates set body = replace(body,
--     '{{notice_days}} calendar days'' prior written notice',
--     'fifteen (15) calendar days'' prior written notice') where kind = 'ic_agreement';
--   (prod read "fifteen (30)" when 46 ran; restore whichever number you mean)
--   alter table contract_versions drop column if exists notice_days;
