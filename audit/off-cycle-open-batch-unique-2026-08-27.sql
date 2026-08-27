-- ============================================================================
-- "One open off-cycle batch per employer" — unique partial index for the
-- SHARED PROD DB (cgsidolrauzsowqlllsz).
-- Mirror of repo migration supabase/migrations/00000000000041 (same index
-- names); this is the PROD-APPLY copy.
-- ============================================================================
--
-- WHY: migration 24's invariant ("one open off-cycle batch per employer") is
-- only a comment — the partial index behind the find-or-create lookup is not
-- unique, so two concurrent opens can create two open batches. The app code
-- shipping with this change catches the 23505 and adopts the winner's batch.
--
-- WHY THIS IS SAFE ON THE SHARED DB (sibling apps still live):
--   * The legacy portal never writes pay_periods (verified: portal/index.html
--     inserts only into documents), so only this app's find-or-create path can
--     ever hit the new constraint.
--   * Nothing is renamed on the table itself; the non-unique index is replaced
--     by a unique one with the same shape, so lookups keep their index.
--   * Pre-flight 2026-08-27 (via MCP): zero open off-cycle batches exist, so
--     the unique build cannot collide.
--
-- HOW TO APPLY (Dashboard SQL Editor — NOT the migration CLI):
--   Run the statements in order. The table is tiny (pay_periods), so plain
--   CREATE UNIQUE INDEX (brief lock) is fine — no CONCURRENTLY needed.

-- 1) Pre-flight — MUST return zero rows; if any appear, close the duplicates
--    (state -> 'locked'/'paid' or delete empty batches) before applying:
select company_id, count(*) as open_off_cycle
from pay_periods
where kind = 'off_cycle' and state = 'open'
group by company_id
having count(*) > 1;

-- 2) Apply:
drop index if exists public.pay_periods_off_cycle_open_idx;

create unique index if not exists pay_periods_off_cycle_open_uniq
  on public.pay_periods (company_id)
  where kind = 'off_cycle' and state = 'open';

-- 3) Verify (expect one row, indisunique = true):
select i.relname, ix.indisunique
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
where i.relname = 'pay_periods_off_cycle_open_uniq';

-- 4) Record: add "00000000000041" to supabase/prod-applied.json `applied`.
