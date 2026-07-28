-- ============================================================================
-- payments remembers the gross the engine computed, so an override is revertible
-- ----------------------------------------------------------------------------
-- RP-07: overriding gross overwrote gross_php in place, and the only trace of
-- the engine's figure was prose inside `note` ("Gross manually overridden
-- (computed 18182)"). Two failures fell out of that:
--   * the ↺ "revert to computed" button restored gross_php — i.e. the override
--     itself — because the client seeded computedGrossPhp from the stored gross;
--   * the SECOND save re-derived the note from the ALREADY-overridden gross, so
--     the note became "(computed 15000)" and the true figure was gone for good.
-- The computed gross now has its own column: captured on the FIRST override,
-- restored (and cleared) when the override is cleared. `note` stays the
-- override marker only (fetchSavedPayments still reads `overridden` from it).
--
-- The backfill recovers the computed figure from the legacy note wherever it
-- survived. Rows already destroyed by the second-save bug backfill to their
-- overridden amount — no worse than today's behaviour, and the ↺ is a no-op
-- there rather than a silent corruption.
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard/MCP (disjoint
-- history), then recorded in supabase/prod-applied.json. ADDITIVE + IDEMPOTENT.
-- ============================================================================

alter table public.payments
  add column if not exists computed_gross_php numeric;

comment on column public.payments.computed_gross_php is
  'The gross the engine computed, captured when gross_php was first manually overridden; null = not overridden. Restored to gross_php when the override is cleared (RP-07).';

-- Backfill from the legacy note. Guarded on `is null`, so re-running is a no-op.
update public.payments
set computed_gross_php = substring(note from 'computed ([0-9]+\.?[0-9]*)')::numeric
where computed_gross_php is null
  and note is not null
  and substring(note from 'computed ([0-9]+\.?[0-9]*)') is not null;

-- ROLLBACK:
--   alter table public.payments drop column if exists computed_gross_php;
