# Deploying abc-helper-app

Two independent deploy paths: the **Next app → Vercel** (this page, top to
bottom) and the **Supabase edge functions → Supabase, by hand**
([jump](#supabase-edge-functions--deployed-by-hand)). Pushing code deploys the
first and *never* the second.

The repo is connected to Vercel via the GitHub integration, so every push to
`main` triggers a build. The Next build calls `src/server/env.ts`, which
**fail-fast validates** the required env vars — so a deploy will FAIL until the
required vars are set in the Vercel project.

Set env vars in **Vercel → Project → Settings → Environment Variables**.

---

## Required (build fails without these)

| Var | Where it comes from |
|-----|---------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon public key |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role key (SECRET) |

`ADMIN_SSO_ALLOWED_DOMAIN` defaults to `abckidsny.com,abbilabs.com` (comma-separated;
admins sign in on `abbilabs.com`). Override only if your admin domains differ.

## Optional (features degrade gracefully when unset)

| Var | Effect when unset |
|-----|-------------------|
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Hire/onboarding emails no-op + log a warning |
| `HIRING_REVIEW_EMAIL_FROM` | From header defaults to `ABC Kids NY <GMAIL_USER>` |
| `APP_URL` | Portal links in emails; set to the public app URL in prod |
| `WISE_API_TOKEN`, `WISE_PROFILE_ID` | Wise drafting actions error when invoked (DRAFT-ONLY; never funds) |
| `HUBSTAFF_REFRESH_TOKEN` | "Sync from Hubstaff" errors when invoked; manual/CSV import still works |
| `CRON_SECRET` | Shared secret for cron-invoked routes (the Deno edge fns) |

---

## Two deployment modes

### A. Dev / preview build (safe — does NOT touch production)

The goal is only to get a green Vercel build + a working app shell. Vercel's
cloud build cannot reach a LOCAL `supabase start` stack, so use **build-safe
placeholders** that satisfy the schema. The app shell renders; data calls won't
resolve until pointed at a reachable Supabase. Set:

```
NEXT_PUBLIC_SUPABASE_URL       = https://placeholder.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY  = placeholder-anon-key-placeholder-anon-key
SUPABASE_SERVICE_KEY           = placeholder-service-key-placeholder-service-key
```

(To get a fully working preview with live data, create a hosted dev Supabase
project and use its real URL + keys instead — but the org is at the free-project
limit, see the migration handoff §8a.)

### B. Production (cutover)

Set the REAL values from the prod Supabase project (`cgsidolrauzsowqlllsz`) plus
the Wise / Hubstaff / Gmail credentials. The app is single-domain with path-based
routing — admin at `/`, contractor portal at `/portal` — served from the new
subdomain `3a.abbilabs.com`. So:

- `APP_URL = https://3a.abbilabs.com` — a **bare origin** (no path). `portalUrl()`
  in `src/server/actions/portal-admin.ts` appends `/portal`, so hire-email portal
  links resolve to `https://3a.abbilabs.com/portal`. Do NOT put a path in `APP_URL`.
- **Supabase Auth redirect URL** — add `https://3a.abbilabs.com/auth/callback` to the
  prod project's allowed redirect URLs. Admin Google OAuth and contractor magic-link
  both round-trip through `/auth/callback` (`src/app/auth/callback/route.ts` redirects
  to `next`, default `/`, then `src/proxy.ts` finishes audience routing). Without this,
  sign-in fails on the new domain.
- **Custom domain** — add `3a.abbilabs.com` as a **new** Vercel custom domain (CNAME →
  Vercel). This is non-destructive: the old `payroll.*` / `portal.*` subdomains keep
  serving the old app, which stays live as the rollback.

Keep new DB migrations additive so the old app remains a valid rollback. See
`docs/CUTOVER-RUNBOOK.md` for the full ordered sequence.

---

## Database migrations → prod (the deploy does NOT apply schema)

**The Vercel deploy ships CODE, not schema.** Pushing to `main` rebuilds the app
but never touches the database. Prod's migration history is **disjoint** from
this repo (prod was conformed via the shared-prod work; `supabase db push` is
never run against prod). So a migration file in `supabase/migrations/` is *not*
in prod until you apply it by hand.

If the deployed code reads a column/table that prod doesn't have yet, the query
throws `column ... does not exist` at runtime and the feature silently breaks in
prod — even though the build was green and tests passed. (This is exactly how the
payroll editor broke once: code shipped reading `payments.off_cycle_php` before
that column existed in prod.)

**Checklist when a change adds/edits a migration:**

1. Because additive migrations are backward-compatible (old code ignores new
   columns), **apply the schema to prod _before_ deploying the code** — never the
   other way around. Run the migration's DDL on the prod project
   (`cgsidolrauzsowqlllsz`) via the **Supabase SQL Editor** (or the Supabase MCP
   `execute_sql`). Keep it additive + idempotent (`add column if not exists`,
   `create table if not exists`).
2. Record the migration's version prefix in **`supabase/prod-applied.json`**
   (under `applied`, with a one-line note).
3. Then push the code.

A pre-push gate (`scripts/check-prod-migrations.mjs`, wired into `lefthook.yml`)
**blocks pushing to `main`** while any migration newer than the recorded baseline
is missing from `supabase/prod-applied.json`. It only warns on other branches.
Run it anytime with `pnpm check:prod-migrations`.

---

## Supabase edge functions — deployed BY HAND

`supabase/functions/hubstaff-sync/` and `supabase/functions/wise-payouts/` are
**not deployed by anything automatic**. `.github/workflows/ci.yml` is
checks-only (lint / typecheck / guardrails / test / build — "no deploy, no
secrets required") and the Vercel integration ships the Next app only. **No
pipeline in either repo has ever deployed an edge function.** Editing a file
under `supabase/functions/` therefore changes *nothing* in production until a
human runs the commands below — this runbook is the only mechanism there is.

### Current state (2026-08-01) — the slot does not run this repo's code

| | |
|---|---|
| Live `hubstaff-sync` slot | version **45**, last updated **~2026-06-23** |
| Source-of-record | **the legacy repo** — `abc-work-app-payroll-wis-hubstaff-app/supabase/functions/hubstaff-sync/index.ts` |
| This repo's copy | **never deployed** |

Both repos' `supabase/.temp/project-ref` is `cgsidolrauzsowqlllsz`, so
`supabase functions deploy` from **either** working copy overwrites the **same
live slot on shared prod**. There is no staging slot and no preview.

The practical consequence today: the no-time-after-last-day guard lives in this
repo's copy and in `upsertTimeEntries` (`src/db/queries/time.ts`), and the
nightly 20:00 UTC `cron_ingest` runs **neither** — it runs version 45, which
reads `ended_on` and never uses it, and keeps upserting `pending` rows for
terminated contractors on a 3-day lookback (issue #80).

### Who calls the slot

| Action | Caller | Implemented in |
|---|---|---|
| `cron_ingest` | `pg_cron` nightly 20:00 UTC (`supabase/migrations/00000000000010_hubstaff_daily_ingest_cron.sql`) | **both** copies |
| `sync_ingest`, `list_orgs`, `list_projects`, `get_user`, `activity_backfill`, default `{org_id,start,stop}` rollup | the **legacy browser app** (`abc-work-app-.../app/index.html`, still live and still the rollback) | **legacy copy only** — this repo's copy answers `400 unknown action` |
| — | **this app** never invokes the function at all: `src/server/actions/hubstaff-sync.ts` calls the Hubstaff API directly from the Next server | n/a |

So nothing in *this* repo breaks whichever copy is deployed. What is at stake is
the legacy admin app's Hubstaff UI (org picker, project mapping, "Sync now",
activity backfill).

### Option A — deploy the legacy copy (smallest blast radius)

The guard has been ported into the legacy file (same `<= lastDay` keep
boundary, same per-`(company, worker)` `ended_on` lookup, `dropped_after_end` in
the response). Deploying it stops the nightly post-termination imports **and
keeps every legacy action working**.

```bash
cd /Users/olivertrinidad/Projects/abc-work-app-payroll-wis-hubstaff-app
git diff supabase/functions/hubstaff-sync/index.ts     # review the ported guard first
git commit -m "fix(hubstaff-sync): no time imports after a contractor's last day" \
  supabase/functions/hubstaff-sync/index.ts
supabase functions deploy hubstaff-sync \
  --project-ref cgsidolrauzsowqlllsz --no-verify-jwt
```

`--no-verify-jwt` is **not optional here**: the legacy repo has no
`supabase/config.toml`, so nothing declares `verify_jwt = false` for that slot,
and the nightly cron POST sends `apikey` + `x-cron-secret` but **no
`Authorization` header** (see migration 0010) — a JWT-verified slot would 401
every night. (If the CLI refuses to run without a config file, add a two-line
`supabase/config.toml` to the legacy repo: `project_id` plus
`[functions.hubstaff-sync] verify_jwt = false`.)

The guard sits in the shared ingest, so it also covers the legacy app's manual
`sync_ingest` — intended (every writer through this function should obey the
last day), but note the legacy UI shows no dropped count, so a departed
contractor's window simply syncs fewer rows with no on-screen explanation.

Cost of Option A: the legacy copy does **not** write the `audit_log` row for
`dropped_after_end` and does not do decided-day divergence logging — both of
those exist only in this repo's copy. `pg_net` discards the HTTP response, so
under Option A a nightly drop leaves no persisted trace. That is the known
ceiling, flagged with a `ponytail:` comment in the legacy file.

### Option B — repoint the source-of-record to this repo

"Repointing" is not a setting; it is deploying this repo's file over the slot
and agreeing that this repo is where the file is edited from then on:

```bash
cd /Users/olivertrinidad/Projects/abc-helper-app
supabase functions deploy hubstaff-sync            # config.toml pins verify_jwt = false
```

Before running it, know what it removes. This repo's copy implements **only**
`cron_ingest`. Every other action the legacy browser app invokes starts
returning `400 unknown action`, which breaks, in the legacy admin app:
Time Import → Option B "Sync now" (`sync_ingest`), the Organization dropdown
(`list_orgs`), the project→client mapping screen (`list_projects`), the
per-profile drift check (`get_user`) and `activity_backfill`.

**So Option B is a cutover step, not a hotfix** — correct once the legacy admin
app is retired (`docs/CUTOVER-RUNBOOK.md`), wrong while it is still the
rollback. Checklist when you do it:

- [ ] Legacy admin app retired, or its Hubstaff screens accepted as broken.
- [ ] Secrets already exist on the project (they are per-project, not per-repo,
      so they survive the swap): `HUBSTAFF_REFRESH_TOKEN`; optionally
      `EMPLOYER_COMPANY_ID`. This repo's copy resolves the employer from
      `companies.kind = 'employer'` when `company_id` is absent — the cron passes
      it explicitly, so this only matters for hand invocations.
- [ ] Prod `time_entries` has `import_batch_id` (this copy writes it on insert;
      a missing column fails the whole batch upsert, not one row).
- [ ] Announce it: the next person to `supabase functions deploy hubstaff-sync`
      from the legacy repo silently reverts to Option A.

### What breaks if the two copies drift

They are two hand-maintained copies of the same money path against one live
slot, and **whichever was deployed last wins** — with no signal anywhere that a
deploy happened or which copy is live.

- **Legacy copy behind → post-termination hours get imported and paid.** Exactly
  issue #80. Silent: the rows land as `pending` and look like ordinary time on
  `/time`.
- **This repo's copy behind → a `pnpm test` that passes proves nothing.**
  `tests/lib/hubstaff/vendored-parity.test.ts` couples `upsertTimeEntries` to
  **this repo's** Deno file only. It never reads the legacy repo and never reads
  the deployed slot, so legacy-copy drift and an un-deployed slot both pass CI
  green. Treat that test as "the two files *in this repo* agree", nothing more.
- **Boundary drift in either direction is a money bug.** `<= lastDay` imports,
  `> lastDay` drops: too strict and the contractor is unpaid for their final
  day; too loose and terminated contractors keep accruing.

The durable fix is the `time_entries` trigger in issue #86 — a DB-level check of
`worker_companies.ended_on` covers *every* writer (both edge copies, the legacy
browser apps, the mobile app) and needs no deploy at all. It now exists as
`supabase/migrations/00000000000038_time_entries_no_time_after_last_day.sql`,
**not yet applied to prod**.

> **Sequencing: do Option A first, then apply migration 38.** The trigger
> *raises*, and PostgREST sends a window as one bulk upsert — so a single
> post-last-day row aborts the **whole statement**. Version 45 has no guard, so
> the first night a departed contractor appears in the Hubstaff window the
> entire batch 400s, and `pg_net` discards the response: the nightly ingest
> writes nothing, invisibly. Deploying the guarded copy (Option A) drops those
> rows before the upsert, so the trigger never fires and the batch lands. Same
> shape for the legacy admin app's CSV import — there the loud failure is
> wanted, and the operator sees it.

### Verify after deploying (read-only)

```bash
supabase functions list --project-ref cgsidolrauzsowqlllsz
```

`hubstaff-sync` should show a **version > 45** and today's `updated_at`. To
prove the guard end-to-end, re-run the cron's own call and read
`dropped_after_end` — note this **writes** (the same upsert the cron does
nightly), so run it knowingly; take `<cron-secret>` from
`select value from app_secrets where key = 'cron_secret'`:

```bash
curl -sS -X POST https://cgsidolrauzsowqlllsz.supabase.co/functions/v1/hubstaff-sync \
  -H 'Content-Type: application/json' \
  -H 'x-cron-secret: <cron-secret>' \
  -d '{"action":"cron_ingest","org_id":258598,
       "company_id":"11111111-1111-1111-1111-111111111111",
       "lookback_days":3,"today":"2026-08-01"}' | jq
```

A response containing the `dropped_after_end` key is proof the deployed slot is
one of the guarded copies; version 45 does not have that field at all. A
non-zero value means days after someone's last day were refused.

### Rollback

Redeploy the other copy — the slot has no version pinning, so rollback is just
`supabase functions deploy hubstaff-sync` from whichever repo holds the
behaviour you want. The pre-guard version 45 behaviour is the legacy file at its
last commit (the ported guard there is uncommitted until you commit it).

---

## vercel.json

`vercel.json` pins the Next framework, the function region, and security headers
(HSTS, nosniff, frame-deny, referrer + permissions policy).

**Keep the region on the database, not on the users.** `pdx1` is Portland =
`us-west-2` = the Supabase project's own region. Every page makes 4–15
*sequential* Supabase round trips (`auth.getUser()`, then one HTTPS call per
query), so the function↔DB hop is paid over and over while the browser↔function
hop is paid once. This was `sin1` ("closest to PH contractors") against a
`us-west-2` database: ~170 ms × every crossing, which is what made the Run
Payroll tabs take seconds. Move the region only if the Supabase project moves.
