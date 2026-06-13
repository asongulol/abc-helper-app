# Cutover runbook

The exact sequence to move production from the old app to `abc-helper-app`, plus
the result of the dry run that validated it. Pair with `docs/DEPLOY.md` (env) and
`docs/CUTOVER-VERIFICATION.md` (parity gate).

## Dry-run result (LOCAL stack, 2026-06-13)

A full payroll cycle was run end-to-end through the new engine against the local
Supabase stack, then verified by the cutover gate. **Every step passed.**

| Step | Tool | Result |
|------|------|--------|
| 1. Run a payroll cycle (calculate → lock → mark paid) | `scripts/cutover-cycle.mjs` | 3 paid statements produced; prorated math correct (80/88 × ₱25,000 = ₱22,727.27, etc.) |
| 2. Cutover gate | `pnpm parity:verify` | **3/3 rows reproduce to the centavo · exit 0** |
| 3. Additive-migration check | repo + prod catalog diff | new app ships **only the baseline migration**; references **only tables that already exist in prod** (0 missing) → cutover is "point at prod," not a schema change; old app stays a valid rollback |
| 4. Build / CI | GitHub Actions | green (lint, typecheck, guardrails, 257 tests, build) |

Two harmless cleanups were found and fixed during the dry run (a REST helper
that mis-parsed empty PostgREST bodies; a dead import in the cycle script). No
issues in the app itself.

## Decisions

- **Domain:** one **new** subdomain `3a.abbilabs.com` for the whole app — admin at
  `/`, contractor portal at `/portal` (path-based routing, already handled by
  `src/proxy.ts`; no proxy change needed). The old `payroll.*` / `portal.*` stay on
  the old app as the live rollback.
- **Timing:** prepare everything now and rehearse against prod read-only; the actual
  flip is a ready-to-run sequence with the date left open.
- **Crons:** single Hubstaff syncer at a time (see Cron handover below).
- **Secrets:** the live token handoff file is local-only (never in the repo) — secure
  it and rotate the tokens as a pre-flight step.

## Pre-flight (any time before cutover — no user impact)

### Secure + rotate secrets
The live token handoff (`docs/ABC-HELPER-APP-VAR`, if you have a local copy) must live
only in a gitignored local file (`.env.local`) — it is `.gitignore`d defensively and
must never be committed. Treat the tokens as leaked and rotate them; the new values land
in Vercel / Supabase, never in a repo file:

- [ ] **Wise** `WISE_API_TOKEN` — revoke + reissue in Wise → API tokens.
- [ ] **Hubstaff** `HUBSTAFF_REFRESH_TOKEN` — re-auth to mint a fresh refresh token.
      This is the same token the live sync rotates, so set the new value in exactly
      **one** place (see Cron handover).
- [ ] **Gmail** `GMAIL_APP_PASSWORD` — revoke + regenerate the app password.
- [ ] **Cron secret** — generate a new random value and write it to the prod
      **`app_secrets.cron_secret`** row. This is the value the edge function validates
      against (`supabase/functions/hubstaff-sync/index.ts:411-415`). Setting `CRON_SECRET`
      in Vercel is optional today (no Next.js route reads it — the only route is
      `/auth/callback`); the load-bearing value is the DB row plus the secret the cron
      invoker sends as `x-cron-secret`.

### Stage prod infra (no flip)
- [ ] CI green on `main`.
- [ ] Vercel env set (see `docs/DEPLOY.md`): real prod Supabase URL + anon + service
      key; `APP_URL = https://3a.abbilabs.com` (bare origin — `portalUrl()` appends
      `/portal`); rotated `WISE_API_TOKEN`/`WISE_PROFILE_ID`, `HUBSTAFF_REFRESH_TOKEN`,
      `GMAIL_USER`/`GMAIL_APP_PASSWORD`; `ADMIN_SSO_ALLOWED_DOMAIN` left at `abckidsny.com`.
- [ ] Supabase Auth redirect URL `https://3a.abbilabs.com/auth/callback` added to the
      prod project (admin OAuth + contractor magic-link both round-trip through it).
- [ ] `3a.abbilabs.com` added as a **new** Vercel custom domain (CNAME → Vercel).
      Non-destructive: `payroll.*` / `portal.*` keep serving the old app, so you can
      fully exercise the new app at `3a.abbilabs.com` while real traffic still flows to
      the old app.
- [ ] Edge function deployed but **NOT scheduled** yet:
      `supabase functions deploy hubstaff-sync`, then
      `supabase secrets set HUBSTAFF_REFRESH_TOKEN=… EMPLOYER_COMPANY_ID=…`, and ensure
      `app_secrets.cron_secret` matches the rotated value.
- [ ] An owner `admin_users` row exists in prod for whoever will sign in
      (prod already has the real admins; no seeding needed).
- [ ] Build green; admin SSO + a test contractor can sign in at `https://3a.abbilabs.com`.

## Cron handover (single Hubstaff syncer at a time)

The only scheduled job is the `hubstaff-sync` edge function. Its `time_entries` writes
are idempotent (upsert on `(company_id, source_name, work_date)`, `index.ts:366`) and it
**skips any already-decided row** (`index.ts:344`), so a double time-sync is harmless.
The danger is the **Hubstaff OAuth refresh-token rotation** (`index.ts:81-104`): Hubstaff
refresh tokens are single-use, so two independent syncers refreshing the same token
invalidate each other. Hence one syncer at any moment:

- **During prep (now → flip):** the **old app stays the sole Hubstaff syncer.** Do NOT
  schedule the new edge function.
- **At the flip:** disable the old app's Hubstaff cron FIRST, then schedule the new edge
  function in Supabase (pg_cron / scheduled function POSTing to `hubstaff-sync` with
  `org_id`, `company_id`, and the `x-cron-secret` header matching `app_secrets.cron_secret`).
  Single writer throughout — no overlap window.
- **Token seeding:** set the freshly rotated `HUBSTAFF_REFRESH_TOKEN` in exactly one place
  going forward — the new app's Supabase secrets + `api_tokens` row. Once the old app's
  cron is off, it no longer touches the token.

## Rehearse the gate vs prod (read-only, any time)

`scripts/parity-verify.mjs` is READ-ONLY (SELECTs only) and safe to point at prod.
Rehearse the exact gate the flip depends on:

```sh
pnpm parity:verify --url https://cgsidolrauzsowqlllsz.supabase.co --key <PROD_SERVICE_KEY>
```

Must print `exit 0` with every checkable row matching (expected 35/35; override and
early-period rows are excluded by design — see `docs/CUTOVER-VERIFICATION.md`). Any new
mismatch ⇒ STOP and investigate before scheduling a flip.

## The flip (between pay periods — pick a window with no open period)

Pick a window right after a period is fully paid (semi-monthly arrears), so there's no
open/locked-unpaid period mid-edit. Pre-flight (above) is already done, so the new app is
live and prod-pointed at `3a.abbilabs.com` with the old app still serving users. Then:

1. **Freeze writes on the old app.** Set the old Cloudflare app to read-only/maintenance,
   or announce a freeze and stop using it. No in-flight open/locked (unpaid) period mid-edit.
2. **Disable the old app's Hubstaff cron** (Cron handover → "At the flip").
3. **Apply any new migrations to prod** — additive only. (Today there are NONE; the new
   app runs on the existing schema. Future migrations must be backward-compatible so the
   old app still reads the DB.)
4. **Run the gate against prod (read-only):**
   ```sh
   pnpm parity:verify --url https://cgsidolrauzsowqlllsz.supabase.co --key <PROD_SERVICE_KEY>
   ```
   Must print `exit 0`. Non-zero ⇒ STOP and investigate the listed rows.
5. **Point users at the new app.** `3a.abbilabs.com` is already live and prod-pointed.
   Confirm a fresh deploy is green; announce the new URL to admins + contractors (their
   old `payroll.*` / `portal.*` bookmarks still hit the old app — see Rollback).
   Optionally add redirects `payroll.* → 3a.abbilabs.com` and
   `portal.* → 3a.abbilabs.com/portal` only **after** a clean period.
6. **Schedule the new app's Hubstaff cron** in Supabase (Cron handover → "At the flip").
7. **Smoke test on prod (read-only):** admin sign-in, Overview tiles, open the most recent
   **paid** period and eyeball one contractor's statement; contractor sign-in to `/portal`
   shows their statements. Do NOT recalculate a paid period.

## First live period on the new app

- Import/approve time as usual → Calculate → review the draft table → Lock →
  draft Wise transfers (OWNER) → **fund manually in the Wise UI** → run
  `wisePoll` / "Check statuses" to reconcile → Mark paid.
- Compare that period's totals against what the old app would have produced for
  the same inputs (the parity gate already guarantees the formula; this is the
  human gut-check).

## Rollback

Because cutover changes no schema and moves no data, rollback is just **keep using the
old app at `payroll.*` / `portal.*`** (still deployed and untouched). If users were moved
to `3a.abbilabs.com`, point them back. Re-enable the old app's Hubstaff cron and re-seed
its refresh token if reverting the cron handover. Keep the old app live until at least one
full pay period has run clean on the new app. If a new additive migration was applied, it
stays (the old app ignores new columns/tables).

## Money safety (always)

The new app NEVER funds Wise transfers — it drafts them; the owner funds in the
Wise UI. The guardrails scanner enforces this in CI. Cutover does not change
this.
