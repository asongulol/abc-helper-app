---
title: Architecture overview
sidebar_position: 1
---

# Architecture overview

ABC Helper is a single **Next.js (App Router)** application backed by **Supabase**
(PostgreSQL + Auth + RLS). One deployment serves two audiences on one origin: the
**admin** console and the **contractor portal**. This page explains how the surfaces are
separated, how a request flows from the browser to the database, and where the major
pieces live.

For the money math itself, see [Money core spec](./money-core-spec.md); for the
business flow, see [Pay pipeline](./pay-pipeline.md).

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js `^16`** (App Router) | Server Components + Server Actions; no separate API server |
| UI | **React `^19`**, Tailwind `^4` | |
| Auth / data | **@supabase/ssr `^0.12`**, supabase-js `^2.108` | Cookie-backed sessions, Postgres + Row-Level Security |
| Validation | **Zod `^4`** | At every action boundary and on env |
| Tests | **Vitest `^4`** | `tests/` mirrors `src/` |
| Lint/format | **Biome `^2.5`** | `pnpm check` |
| Hooks | **lefthook** | pre-commit (check/typecheck) + pre-push (guardrails/tests) |
| Runtime | **Node ≥ 24** (Volta 24.16.0), **pnpm 9.12** | `"type": "module"` |

## Two surfaces, one origin

Both the admin console and the contractor portal are routed from the same Next.js app and
share one Supabase Auth pool. They are kept apart by **path prefix + a server-side role
gate**, not by separate deployments.

```mermaid
flowchart TD
  Req[Browser request] --> Proxy["src/proxy.ts — path + role gate"]
  Proxy -->|/login, (admin)/*| AdminLayout["(admin)/layout.tsx<br/>getCurrentAdmin() or redirect /login"]
  Proxy -->|/portal/*| PortalLayout["portal/(authed)/layout.tsx<br/>getCurrentWorker() or redirect /portal/login"]
  Proxy -->|/api/cron/*| Cron["cron routes — x-cron-secret, no session"]
  Proxy -->|/login, /portal/login, /auth/callback| Public[Public routes]
  AdminLayout --> Action
  PortalLayout --> Action["Server Action ('use server')"]
  Action --> Service["src/server/* service (optional)"]
  Service --> Query["src/db/queries/* (db passed in)"]
  Action --> Query
  Query --> Supa[(Supabase / Postgres + RLS)]
  Action -.uses.-> Lib["src/lib/* — pure logic"]
```

### The gate — `src/proxy.ts`

- **Public paths** bypass the gate entirely: `/login`, `/portal/login`, `/auth/callback`.
- **Cron routes** (`/api/cron/*`) bypass session auth — they authenticate with the
  `x-cron-secret` header instead (see [Pay pipeline](./pay-pipeline.md) and the cron docs).
- Everything else requires a Supabase session (`supabase.auth.getUser()`). With no session,
  the gate redirects to `/login` (admin area) or `/portal/login` (portal).
- **Role routing** is by prefix: `isPortal = pathname === '/portal' || pathname.startsWith('/portal/')`.
  Admins own everything *except* the portal; contractors own the portal.
  - An **admin** with an `admin_users` row may preview the portal (the gate lets them through).
  - A **contractor** who lands in the admin area without a `contractor_logins` row is signed
    out and sent to `/portal/login`.
- The gate uses the **anon client + RLS only** — no service-role key runs at the edge.

### Who is who

| | Admin | Contractor |
|---|---|---|
| Sign-in | `/login` (Google SSO) | `/portal/login` (email + password) |
| Backing table | `admin_users` | `contractor_logins` (+ `workers`) |
| Resolver | `getCurrentAdmin()` — `src/server/auth/admin.ts` | `getCurrentWorker()` — `src/server/auth/worker.ts` |
| Domain gate | `ADMIN_SSO_ALLOWED_DOMAIN` allowlist (`src/server/auth/allowed-domains.ts`) | none — personal-domain emails |
| Roles | `owner` \| `admin`; owner sees all companies, others scoped via `admin_companies` | one worker, scoped by RLS to their own rows |

`getCurrentWorker()` filters `contractor_logins.status = 'active'`, mirroring the RLS helper
`my_worker_id()` exactly — a revoked login resolves to no worker. SSO domain matching is
**exact** (a look-alike subdomain like `sub.abckidsny.com` is rejected); the pure matcher
lives in `src/lib/auth/allowed-domains.ts`.

## Request lifecycle: action → service → query → DB

There is **no REST API for app data**. Mutations are **Next.js Server Actions** (files marked
`'use server'` in `src/server/actions/`). The only real HTTP endpoints are the two cron routes
and the OAuth callback (`src/app/api/cron/*`, `src/app/auth/callback`).

Each action follows the same shape:

1. **Re-verify identity** at point of use — `getCurrentAdmin()` / `getCurrentWorker()` (or a
   `require*` variant). The proxy gate is the first line of defense; this is the second (ADR-0004).
2. **Validate input** with a Zod schema.
3. **Orchestrate**: optionally call a `src/server/*` service (e.g. `src/server/payroll.ts`,
   `src/server/wise/service.ts`) that fetches → computes → persists.
4. **Read/write** through `src/db/queries/*`, where the Supabase client is passed in as the
   first argument (dependency injection, ADR-0002/0003) so RLS scoping is explicit.
5. **Log** to the audit trail; return a typed `ActionResult` (`{ ok: true; data }` | `{ ok: false; error }`).

Two database clients exist, chosen deliberately:

- `createServerSupabase()` — **anon key + RLS**, cookie-backed. The default for user-scoped work.
- `createServiceClient()` — **service-role**, bypasses RLS. Used only after an explicit admin
  role check (e.g. creating an auth user). Never reaches the browser bundle (`server-only`).

## Where things live

```
src/
  app/                      Next.js routes (Server Components + pages)
    (admin)/                Admin console (layout enforces getCurrentAdmin)
    portal/(authed)/        Contractor portal (layout enforces getCurrentWorker)
    api/cron/               The only real HTTP endpoints (x-cron-secret)
    auth/callback/          OAuth callback (SSO domain gate)
    login/, portal/login/   Public sign-in pages
  server/
    actions/                'use server' mutations — the app's "API" (22 files)
    auth/                   Session resolvers + SSO domain allowlist
    <domain>/               Service orchestration (payroll, hubstaff, wise, documents, …)
    crypto/                 PHI envelope encryption (local key or AWS KMS)
    env.ts                  Zod-validated environment (fail-fast at boot)
  db/
    clients/                createServerSupabase (RLS) / createServiceClient (service-role)
    queries/                Typed read/write helpers (17 modules; db injected)
  lib/                      Pure, DB-free logic — money, dates, pay, payroll mappers, …
  proxy.ts                  Single-origin path + role gate
```

`src/lib/*` is pure and unit-tested in isolation (no DB, no env). Anything touching Supabase
lives in `src/db/queries/*` or a `src/server/*` service. This boundary is what lets the money
engine be tested against parity fixtures (see [Money core spec](./money-core-spec.md)).

## Environment & secrets

`src/server/env.ts` validates the environment with Zod **at boot** and fails fast. Required:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
- `ADMIN_SSO_ALLOWED_DOMAIN` (defaults to `abckidsny.com,abbilabs.com`)

Optional integrations validate lazily in their adapters (missing → feature is a no-op, not a
crash): `WISE_API_TOKEN`/`WISE_PROFILE_ID`, `HUBSTAFF_REFRESH_TOKEN`, `CRON_SECRET`,
`GMAIL_USER`/`GMAIL_APP_PASSWORD`, `APP_URL`, and the PHI key vars (`PHI_KMS_PROVIDER`,
`PHI_LOCAL_MASTER_KEY` / `PHI_KMS_KEY_ID`). Secrets are **server-side only** — `NEXT_PUBLIC_*`
secrets are blocked by `scripts/guardrails.mjs`. See [Local development](./local-development.md)
for the full list with setup notes.

## Cross-cutting rules

- **Money is integer centavos** via branded types (`src/lib/money`); never floats (ADR-0006).
- **Wise is draft-only** — no funding endpoint is ever called (ADR-0007; enforced by
  `scripts/guardrails.mjs` in pre-push + CI). See [Pay pipeline](./pay-pipeline.md).
- **Shared production DB**: this repo's local migrations must never be pushed to the shared
  prod project. Prod changes go only through `audit/*.sql` in the Dashboard SQL Editor, guarded
  by `pnpm db:guard`. See [Prod conformance plan](./PROD-CONFORMANCE-PLAN.md).
