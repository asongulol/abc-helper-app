---
title: Cron & secrets
sidebar_position: 12
---

# Cron & secrets

This app runs four scheduled jobs and keeps every secret in one of two places: a Zod-validated
**environment** (`src/server/env.ts`) or the **`app_secrets`** DB table. None of the cron jobs
carries an end-user session — cron ticks have no logged-in user, so a Supabase JWT can't apply.
Each is gated instead by a shared **`x-cron-secret`** header. See the env summary in
[Architecture overview](./architecture.md).

## Two kinds of scheduled job

| Job | Kind | Trigger | What it does | Auth |
|---|---|---|---|---|
| `POST /api/cron/doc-expiry` | Next.js route | scheduler POSTs the deployed app | Document-expiry digest: classify overdue / expiring-soon docs, email an admin digest | `x-cron-secret` ⇔ `CRON_SECRET` (env) |
| `POST /api/cron/hiring-review` | Next.js route | scheduler POSTs the deployed app | Hiring-review digest: config-driven (the admin's `reminders`), email docs awaiting HR review | `x-cron-secret` ⇔ `CRON_SECRET` (env) |
| `hubstaff-sync` | Supabase Deno edge fn | nightly cron (`pg_cron` + `pg_net`) | Nightly Hubstaff time ingest — writes pending, un-approved `time_entries` | `x-cron-secret` ⇔ `app_secrets.cron_secret` |
| `wise-payouts` | Supabase Deno edge fn | cron every 6h (`pg_cron` + `pg_net`) | Wise payout **reconcile** (poll) — draft-only: GETs transfer detail, PATCHes payment status | `x-cron-secret` ⇔ `app_secrets.cron_secret` |

The two paths exist because the digests must email through the app's nodemailer transport, so
they target the Next.js app; the two edge functions are the app's only edge functions (the
"exactly two edge functions" rule in `supabase/config.toml`). Both edge functions set
`verify_jwt = false` — a deliberate, documented choice, not the legacy "every function
`--no-verify-jwt`" default.

### Next.js cron routes

`src/app/api/cron/doc-expiry/route.ts` and `src/app/api/cron/hiring-review/route.ts`. Both run on
the Node runtime (`runtime = 'nodejs'`, for nodemailer + the service-role client) and are
`force-dynamic`. Each first calls `isValidCronRequest(req)` (`src/server/cron.ts`) and returns
`401` on a bad/missing secret, then runs its service function:

- **doc-expiry** → `runExpiryCheck({ skipEmail: false })` (`src/server/documents/service.ts`).
  Reads across all companies with the service client, classifies via `classifyExpiry`, and emails
  the digest (the on-demand admin action runs the same check with `skipEmail`). Returns counts of
  `overdue` / `expiringSoon` and whether it `emailed`.
- **hiring-review** → `runScheduledHiringReviewDigest()`. The cron fires **daily**; this function
  reads the admin's `reminders` config (Configuration → Onboarding) and decides whether today
  actually emails: `enabled: false` → skipped (`disabled`); `frequency` not matching today →
  skipped (`frequency`); otherwise `runHiringReviewCheck` with `send_to` recipients (falling back
  to `GMAIL_USER`) and `include_deferred`. See [Onboarding & documents](./onboarding-documents.md).

Both service functions are **read-only** against the DB — they never write. Email is best-effort
(see [Email delivery](#email-delivery)).

### Supabase edge functions

`supabase/functions/hubstaff-sync/index.ts` and `supabase/functions/wise-payouts/index.ts` are
thin Deno wrappers around the pure libs in `src/lib/*` (vendored, since Deno can't import from the
Next.js `src/` tree at runtime). Each handler reads `x-cron-secret` from the request, fetches
`app_secrets.cron_secret` over the Supabase REST API, and returns `401` unless they match.

- **`hubstaff-sync`** (`action: cron_ingest`) — nightly Hubstaff ingest. Re-pulls a 3-day rolling
  window and upserts `pending`, un-approved `time_entries`; approval and calculation stay manual.
  See [Hubstaff integration](./hubstaff.md).
- **`wise-payouts`** (`action: cron_reconcile`) — reconcile only. **Money is draft-only**
  (ADR-0007): it GETs transfer detail and PATCHes payment status, and by construction has no
  funding call. The build-time guardrail scans this directory too. See
  [Wise payouts](./wise.md).

## Schedules

All four schedules are codified as `cron.schedule(...)` upserts (idempotent — keyed by job name)
in `supabase/migrations/`. `pg_cron` + `pg_net` are enabled in the baseline.

| Job (cron name) | Cron expr | When | Migration |
|---|---|---|---|
| `hubstaff-daily-ingest` | `0 20 * * *` | daily 20:00 UTC (04:00 Asia/Manila) | `00000000000010_hubstaff_daily_ingest_cron.sql` |
| `wise-payouts-reconcile` | `0 */6 * * *` | every 6 hours | `00000000000016_scheduled_digests_and_wise_cron.sql` |
| `documents-expiry-digest` | `0 21 * * *` | daily 21:00 UTC (05:00 Asia/Manila) | `00000000000016_scheduled_digests_and_wise_cron.sql` |
| `hiring-review-digest` | `15 21 * * *` | daily 21:15 UTC | `00000000000016_scheduled_digests_and_wise_cron.sql` |

The two digest jobs POST to `app_secrets.app_base_url || '/api/cron/<route>'` — `app_base_url` is
seeded with a `CHANGE-ME` placeholder in migration 0016 and must be set per environment. The two
edge-function jobs POST a fixed Supabase function URL tied to this project ref; repoint the URL +
anon `apikey` before applying in another project/branch. All four pass the secret as
`(select value from app_secrets where key = 'cron_secret')`.

## The cron secret

The same shared secret is checked on both paths but is read from **two different stores**:

- **Next.js routes** read `env.CRON_SECRET` (`src/server/env.ts`, optional). `cronSecretOk`
  (`src/lib/cron/secret.ts`) is **fail-closed**: a request is valid only when a secret is
  configured *and* the header matches. With `CRON_SECRET` unset, every cron POST gets `401`.
- **Edge functions** read `app_secrets.cron_secret` from the DB.

**Cutover requirement:** for the deployed setup to work, `CRON_SECRET` (env) and
`app_secrets.cron_secret` (DB) must hold the **same value**. The migrations source the secret
from `app_secrets`, so whatever is seeded there must also be set as the app's `CRON_SECRET`.

## Secrets inventory

Two stores. Env vars are server-side only (`NEXT_PUBLIC_*` secrets are blocked by
`scripts/guardrails.mjs`); `app_secrets` is a key/value table read by Postgres functions and the
edge functions. See the env summary in [Architecture overview](./architecture.md) and the setup
notes in [Local development](./local-development.md).

### Environment (`src/server/env.ts`)

| Var | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase client config |
| `SUPABASE_SERVICE_KEY` | yes | Service-role client (cross-company reads in the digests) |
| `CRON_SECRET` | optional | Shared secret for the Next.js cron routes (must match `app_secrets.cron_secret`) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | optional | Gmail SMTP for transactional + digest email; also the default digest recipient |
| `HIRING_REVIEW_EMAIL_FROM` | optional | `Name <addr>` override for the From header |
| `HUBSTAFF_REFRESH_TOKEN` (`HUBSTAFF_API_BASE`) | optional | Hubstaff time ingest (validated lazily) |
| `WISE_API_TOKEN` / `WISE_PROFILE_ID` | optional | Wise draft/reconcile (validated lazily) |
| `PHI_KMS_PROVIDER`, `PHI_LOCAL_MASTER_KEY`, `PHI_KMS_KEY_ID` | optional | PHI column encryption (envelope; local key or AWS KMS) |

Optional integrations validate **lazily** in their adapters — a missing credential makes the
feature a no-op, not a boot crash.

### DB table (`public.app_secrets`)

`key` / `value` text rows, `service_role`-only.

| Key | Purpose |
|---|---|
| `cron_secret` | Shared secret the edge functions check `x-cron-secret` against |
| `app_base_url` | App origin the digest cron jobs POST to (placeholder in migration 0016; set per env) |
| `tools_enc_key` | Symmetric key for encrypting/decrypting onboarding tool credentials (baseline pgcrypto functions) |

> Note: the Gmail credentials are env vars (`GMAIL_USER` / `GMAIL_APP_PASSWORD`), **not**
> `app_secrets` rows — no `gmail_*` key is referenced in any migration or edge function. The edge
> functions also receive their own integration secrets via `supabase secrets set`
> (`HUBSTAFF_REFRESH_TOKEN`, `WISE_API_TOKEN`, `WISE_PROFILE_ID`, plus `SUPABASE_SERVICE_ROLE_KEY`).

## Email delivery

Digest email goes through `sendEmail({ to, subject, html })`
(`src/server/email/transport.ts`) over **Gmail SMTP** (`smtp.gmail.com:465`, app-password auth, a
fresh transporter per send). It is **best-effort**: it never throws — when `GMAIL_USER` /
`GMAIL_APP_PASSWORD` are unset it logs a warning and returns `{ ok: false, error: 'email not
configured' }`, so a missing credential is a no-op, not a cron failure. Both digest routes surface
this as `emailed: false` (+ `emailError`) rather than a `500`.

Templates / HTML escaping live in `src/server/email/templates.ts` (`escapeHtml`, `mergeTemplate`,
the new-hire templates). Locally there are no Gmail creds, so SMTP is caught by **Inbucket** — see
[Local development](./local-development.md).
