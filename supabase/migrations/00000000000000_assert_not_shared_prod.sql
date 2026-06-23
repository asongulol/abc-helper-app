-- ⛔ GUARD: refuse to run abc-helper-app's repo migrations against the SHARED PROD DB.
-- ---------------------------------------------------------------------------
-- abc-helper-app shares prod (cgsidolrauzsowqlllsz) with 3 live original apps and
-- must NEVER push its repo migration lineage there (prod's history is disjoint;
-- `supabase db push` would try to re-baseline the live DB). Prod-side changes go
-- ONLY through audit/*.sql in the Dashboard SQL Editor (additive, line-reviewed).
--
-- This guard runs FIRST (ordered before the 0001 baseline). It aborts the run if
-- the target DB carries `public.my_clients()` — a function the originals define and
-- that NO repo migration creates, so it is present on prod but absent from a
-- from-scratch local/CI database. Net effect:
--   • local `supabase db reset` / CI: empty DB has no my_clients → no-op, baseline runs.
--   • accidental `supabase db push` at prod: my_clients present → EXCEPTION, push aborts
--     before any migration is applied.
-- (Note: a raw `supabase db reset --linked` against prod is NOT caught here — it drops
--  the schema first — so never run that; the npm db:push wrapper + project-ref check is
--  the second layer. See scripts/assert-local-supabase-target.mjs.)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regprocedure('public.my_clients()') IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to run abc-helper-app repo migrations against the shared prod DB (public.my_clients() is present). Prod-side changes go via audit/*.sql in the Dashboard SQL Editor. See docs/PROD-CONFORMANCE-PLAN.md.'
      USING errcode = 'raise_exception';
  END IF;
END $$;
