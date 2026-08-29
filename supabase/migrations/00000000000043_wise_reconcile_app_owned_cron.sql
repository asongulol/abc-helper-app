-- ============================================================================
-- 40: Wise reconcile cron — app-owned (owner decision 2026-08-29)
-- ----------------------------------------------------------------------------
-- Migration 0016 defined `wise-payouts-reconcile` targeting the Deno edge
-- function, but that job was NEVER applied to prod: since cutover, Wise status
-- checks have been manual only ("Check statuses" / wisePoll). The owner decided
-- the scheduled path should be owned by the new system, so the job targets the
-- Next route /api/cron/wise-reconcile (same shape as the two digests and
-- portal-sunset), which runs the SAME servicePoll as the manual button:
-- draft-only, flips payments to 'sent' on terminal Wise success with Wise's
-- real dates. DRAFT-ONLY money safety — no funding endpoint exists in the app.
--
-- Do NOT also apply migration 0016's `wise-payouts-reconcile` block — this
-- supersedes it (the vendored edge functions stay local-dev only; deploying
-- them would overwrite the legacy v10 functions the live apps depend on).
--
-- PROJECT-SPECIFIC: app_secrets.app_base_url must point at the deployed app and
-- the app's CRON_SECRET must match app_secrets.cron_secret (same as 0016/0039).
-- The route 404s until the app revision containing it is deployed — schedule
-- order is harmless (a missed tick reconciles on the next one; idempotent).
--
-- IDEMPOTENT — cron.schedule upserts by job name.
-- ============================================================================

BEGIN;

-- Every 6h, same cadence migration 0016 intended.
select cron.schedule(
  'wise-reconcile',
  '0 */6 * * *',
  $job$
  select net.http_post(
    url := (select value from public.app_secrets where key = 'app_base_url') || '/api/cron/wise-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

COMMIT;

-- ROLLBACK:
--   select cron.unschedule('wise-reconcile');
