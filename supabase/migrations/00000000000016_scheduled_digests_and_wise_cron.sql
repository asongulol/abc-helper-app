-- 0016 — schedule the three jobs that had no captured cron (audit/05 §2.2/§2.6):
--   * wise-payouts reconcile  → the existing Deno edge function (DRAFT-ONLY GET+PATCH)
--   * document-expiry digest  → Next route /api/cron/doc-expiry  (runExpiryCheck, emails)
--   * hiring-review digest     → Next route /api/cron/hiring-review (runHiringReviewCheck)
--
-- The two digests must email via the app's nodemailer transport, so they target the
-- Next.js app (cron-secret-gated route handlers) rather than a Deno edge function —
-- the app intentionally keeps "exactly two edge functions" (config.toml).
--
-- Idempotent: cron.schedule(name, ...) upserts by job name; re-applying updates in
-- place. pg_cron + pg_net are enabled in the baseline (same as migration 0010).
--
-- PROJECT-SPECIFIC, set before applying elsewhere:
--   * app_secrets.cron_secret  — shared with the app's CRON_SECRET env (already seeded).
--   * app_secrets.app_base_url — the deployed app origin the cron POSTs to (seeded with a
--     placeholder below; UPDATE it per environment).
--   * the wise-payouts edge function URL + anon apikey are tied to this project ref
--     (cgsidolrauzsowqlllsz), exactly like migration 0010.

BEGIN;

-- App origin the Next cron routes are POSTed to (no trailing slash). Replace per env.
INSERT INTO public.app_secrets (key, value)
VALUES ('app_base_url', 'https://CHANGE-ME.example.com')
ON CONFLICT (key) DO NOTHING;

-- 1. Wise payout reconcile — every 6h. Existing edge fn; money is DRAFT-ONLY (ADR-0007),
--    this only GETs transfer detail and PATCHes payment status.
select cron.schedule(
  'wise-payouts-reconcile',
  '0 */6 * * *',
  $job$
  select net.http_post(
    url := 'https://cgsidolrauzsowqlllsz.supabase.co/functions/v1/wise-payouts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNnc2lkb2xyYXV6c293cWxsbHN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDMwMzEsImV4cCI6MjA5NTM3OTAzMX0.2Z_dDcN0la3c5l2YMYWjeUejhAGZH4ROHXQtYRGWYfY',
      'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')
    ),
    body := jsonb_build_object('action', 'cron_reconcile'),
    timeout_milliseconds := 150000
  );
  $job$
);

-- 2. Document-expiry digest — daily 21:00 UTC (05:00 Asia/Manila).
select cron.schedule(
  'documents-expiry-digest',
  '0 21 * * *',
  $job$
  select net.http_post(
    url := (select value from public.app_secrets where key = 'app_base_url') || '/api/cron/doc-expiry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- 3. Hiring-docs review digest — daily 21:15 UTC.
select cron.schedule(
  'hiring-review-digest',
  '15 21 * * *',
  $job$
  select net.http_post(
    url := (select value from public.app_secrets where key = 'app_base_url') || '/api/cron/hiring-review',
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
