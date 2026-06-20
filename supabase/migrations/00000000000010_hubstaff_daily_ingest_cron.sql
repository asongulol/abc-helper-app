-- Daily Hubstaff hours ingest — codify the scheduled cron job in source
-- ---------------------------------------------------------------------------
-- The nightly time pull was configured directly on the deployed database and
-- never lived in version control: the repo shipped the `hubstaff-sync` edge
-- function and enabled `pg_cron`/`pg_net` (baseline), but the actual schedule
-- existed only as a hand-created `cron.job` row. If the project were rebuilt
-- from migrations alone, the daily pull would NOT come back. This migration
-- makes it reproducible.
--
-- Behaviour (mirrors the live job exactly):
--   * runs every day at 20:00 UTC = 04:00 Asia/Manila
--   * POSTs to the `hubstaff-sync` edge function with action `cron_ingest`
--   * re-pulls a 3-day window (catches late edits/approvals) and writes
--     PENDING, un-approved time_entries — approval/calculation stay manual
--   * authenticates with the shared `x-cron-secret`, read from app_secrets
--     (never hard-coded); the function has verify_jwt = false (config.toml)
--
-- Idempotent: `cron.schedule(name, ...)` upserts by job name, so applying this
-- updates the existing `hubstaff-daily-ingest` job in place (no duplicate) and
-- re-applies cleanly.
--
-- PROJECT-SPECIFIC: the function URL and the public `apikey` (anon) below are
-- tied to this project ref (cgsidolrauzsowqlllsz). Point them at a different
-- project/branch before applying there. The org_id / company_id identify the
-- single employer's Hubstaff org and are intentionally explicit.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'hubstaff-daily-ingest',
  '0 20 * * *',
  $job$
  select net.http_post(
    url := 'https://cgsidolrauzsowqlllsz.supabase.co/functions/v1/hubstaff-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnc2lkb2xyYXV6c293cWxsbHN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDMwMzEsImV4cCI6MjA5NTM3OTAzMX0.2Z_dDcN0la3c5l2YMYWjeUejhAGZH4ROHXQtYRGWYfY',
      'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')
    ),
    body := jsonb_build_object(
      'action', 'cron_ingest',
      'org_id', 258598,
      'company_id', '11111111-1111-1111-1111-111111111111',
      'lookback_days', 3,
      'today', to_char((now() at time zone 'Asia/Manila')::date, 'YYYY-MM-DD')
    ),
    timeout_milliseconds := 150000
  );
  $job$
);
