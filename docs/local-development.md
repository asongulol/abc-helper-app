---
title: Local development
sidebar_position: 2
---

# Local development

How to get a working local instance — app, local Supabase, an admin login, and a contractor
portal login — from a fresh clone. For how the pieces fit together, read
[Architecture overview](./architecture.md) first.

## Prerequisites

- **Node ≥ 24** — the repo pins **24.16.0** via Volta (`package.json` → `volta`). Install
  [Volta](https://volta.sh) and it picks up the right version automatically.
- **pnpm 9.12** — declared as `packageManager`; `corepack enable` will provision it.
- **Supabase CLI** + **Docker** — for the local Postgres/Auth stack (`supabase start`).

## 1. Install

```sh
pnpm install          # also installs lefthook git hooks (prepare script)
```

The `prepare` script runs `lefthook install || true`, wiring the pre-commit (Biome check +
typecheck) and pre-push (guardrails + tests) hooks.

## 2. Start local Supabase

```sh
supabase start
```

This boots the local stack from `supabase/config.toml`. The services you'll use:

| Service | URL | Notes |
|---|---|---|
| API (PostgREST + Auth) | `http://127.0.0.1:54321` | `NEXT_PUBLIC_SUPABASE_URL` |
| Postgres | `postgresql://…@127.0.0.1:54322/postgres` | direct DB access |
| Studio | `http://127.0.0.1:54323` | DB browser UI |
| Inbucket | `http://127.0.0.1:54324` | catches outgoing email locally |

`supabase start` prints the local **anon** and **service-role** keys — copy them into
`.env.local` next.

## 3. Configure `.env.local`

Copy the example and fill in the Supabase values from step 2:

```sh
cp .env.local.example .env.local
```

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | `http://127.0.0.1:54321` locally |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | from `supabase start` output |
| `SUPABASE_SERVICE_KEY` | ✅ | service-role key (server-only) |
| `ADMIN_SSO_ALLOWED_DOMAIN` | default set | `abckidsny.com,abbilabs.com`; gates admin SSO only |
| `APP_URL` | default set | `http://localhost:3000`; base for portal links in emails |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | optional | transactional email; **no-op if unset** (caught by Inbucket locally) |
| `HIRING_REVIEW_EMAIL_FROM` | optional | `"Name <addr>"` From override |
| `HUBSTAFF_REFRESH_TOKEN` | optional | time ingestion; sync is a no-op without it |
| `WISE_API_TOKEN` / `WISE_PROFILE_ID` | optional | Wise drafts (staging only — **funding is forbidden**) |
| `CRON_SECRET` | optional | shared secret for `/api/cron/*` |
| `PHI_KMS_PROVIDER` / `PHI_LOCAL_MASTER_KEY` / `PHI_KMS_KEY_ID` | optional | PHI envelope encryption (`local` for dev) |

Integration secrets are validated lazily — leaving Wise/Hubstaff/Gmail blank just disables
those features locally; the app still boots. `src/server/env.ts` fails fast only on the
required Supabase + SSO vars.

## 4. Seed an admin + demo data

```sh
pnpm dev:bootstrap
```

`scripts/dev-bootstrap.mjs` is **idempotent** and does two things:

1. Creates (or finds) a GoTrue auth user and an `admin_users` row with `role: 'owner'`,
   `can_countersign: true`.
2. Pipes `supabase/seed.sql` into the local Postgres container — companies, workers, rates,
   approved time, `portal_settings.editable_fields`, and ~2 months of activity history.

**Admin login** → sign in at `/login`:

```
owner@abckidsny.com  /  devpassword123
```

Override with `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` if needed.

> The seed creates the **employer/clients, workers, rates, and time**, but not the contractor
> *login* — that's step 5.

## 5. Seed a contractor portal login

```sh
node scripts/dev-seed-contractor.mjs
```

`scripts/dev-seed-contractor.mjs` is also idempotent. It creates a GoTrue auth user, links it
to an existing `workers` row via `contractor_logins` (`status: 'active'`), and marks
`onboarding_progress` complete so the login lands straight in the full portal.

**Portal login** → sign in at `/portal/login`:

```
maria@abckidsny.com  /  devpassword123     (worker a0000000-…-0001, Maria Santos)
```

Override the target/credentials with `DEV_CONTRACTOR_WORKER_ID`, `DEV_CONTRACTOR_EMAIL`,
`DEV_CONTRACTOR_PASSWORD`. (A prior session referenced `maria@demo.test` — that was a one-off
manual provision; the reproducible default is `maria@abckidsny.com`.)

## 6. Run the app

```sh
pnpm dev          # http://localhost:3000
```

- Admin console → `http://localhost:3000/login`
- Contractor portal → `http://localhost:3000/portal/login`

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server (`:3000`) |
| `pnpm build` / `pnpm start` | production build / serve |
| `pnpm test` | Vitest once · `pnpm test:watch` for watch mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check` | Biome lint + format (`--write`) · `pnpm lint` / `pnpm format` for one side |
| `pnpm guardrails` | security gate (centavos/Wise-draft/secret scanners) — runs in pre-push + CI |
| `pnpm parity:verify` | re-runs the money engine against fixtures (cutover gate) |
| `pnpm changelog` | regenerate the changelog |
| `pnpm docs` / `docs:build` / `docs:serve` | this docs site (`website/`, port 3100) |

## Database safety (shared production)

This repo **shares its production database with three live apps**. Local migrations must never
reach prod.

- `pnpm db:guard` (`scripts/assert-local-supabase-target.mjs`) reads `supabase/.temp/project-ref`
  and **exits 1** if you're linked to the shared prod ref (`cgsidolrauzsowqlllsz`).
- `pnpm db:push` runs `db:guard` first, so the guard can't be bypassed through the npm script.
- An in-DB backstop migration also asserts you're not on shared prod.
- **Never** run `supabase db push`, `migration repair`, or `db reset --linked` against prod.
  Production changes go only via `audit/*.sql` applied in the Dashboard SQL Editor — see
  [Prod conformance plan](./PROD-CONFORMANCE-PLAN.md).

`supabase db reset` (local) re-applies migrations and re-runs `seed.sql`; follow it with
`pnpm dev:bootstrap` to recreate the admin + contractor logins.
