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

`ADMIN_SSO_ALLOWED_DOMAIN` defaults to `abckidsny.com`; override only if needed.

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

### B. Production (cutover — Phase 6 only)

Set the REAL values from the prod Supabase project (`cgsidolrauzsowqlllsz`) plus
the Wise / Hubstaff / Gmail credentials and `APP_URL` = the public URL. Do this
only when actually cutting over, between pay periods. Keep new DB migrations
additive so the old app remains a valid rollback.

---

## vercel.json

`vercel.json` pins the Next framework, the Singapore region (`sin1`, closest to
PH contractors), and security headers (HSTS, nosniff, frame-deny, referrer +
permissions policy). Adjust the region if your Supabase project is elsewhere.
