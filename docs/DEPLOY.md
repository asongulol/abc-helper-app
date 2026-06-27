# Deploying abc-helper-app to Vercel

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

## vercel.json

`vercel.json` pins the Next framework, the Singapore region (`sin1`, closest to
PH contractors), and security headers (HSTS, nosniff, frame-deny, referrer +
permissions policy). Adjust the region if your Supabase project is elsewhere.
