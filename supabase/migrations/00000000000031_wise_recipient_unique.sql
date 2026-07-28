-- ============================================================================
-- One Wise recipient belongs to exactly one contractor (RP-55)
-- ----------------------------------------------------------------------------
-- workers.wise_recipient_id (numeric Wise recipient) and workers.wise_recipient_uuid
-- (the manual Batch-CSV recipient UUID) each identify a BANK ACCOUNT. Nothing
-- stopped two contractors carrying the same one: both nets then land in that one
-- account, and the shortchanged contractor's payment still "reconciles" because
-- the Wise matcher keys on recipient + amount. Only a manual bank review would
-- ever surface it.
--
-- PARTIAL indexes on purpose — most contractors have NULL for both columns (BPI /
-- cash payouts, or Wise not set up yet), and NULLs must stay unrestricted. The
-- uuid index also excludes '' because the legacy portal writes the empty string
-- rather than NULL when a UUID is cleared.
--
-- The app pre-checks first (recipientTaken in actions/wise-recipients.ts) so the
-- owner sees WHO holds the identifier; this index is the guard that also covers
-- the legacy portal, which writes these columns on the same database.
--
-- ⚠️ Local/CI only until hand-applied to prod via MCP (disjoint history).
-- Idempotent (IF NOT EXISTS). NOT concurrent: the workers table is small.
--
-- Pre-flight — this migration FAILS if prod already holds a duplicate. Check and
-- clear before applying:
--   select wise_recipient_id, count(*) from workers
--    where wise_recipient_id is not null group by 1 having count(*) > 1;
--   select wise_recipient_uuid, count(*) from workers
--    where coalesce(wise_recipient_uuid,'') <> '' group by 1 having count(*) > 1;
-- ============================================================================

create unique index if not exists workers_wise_recipient_id_uniq
  on public.workers (wise_recipient_id)
  where wise_recipient_id is not null;

create unique index if not exists workers_wise_recipient_uuid_uniq
  on public.workers (wise_recipient_uuid)
  where wise_recipient_uuid is not null and wise_recipient_uuid <> '';

-- ROLLBACK:
--   drop index if exists public.workers_wise_recipient_id_uniq;
--   drop index if exists public.workers_wise_recipient_uuid_uniq;
