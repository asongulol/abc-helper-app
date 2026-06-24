---
title: Hubstaff integration
sidebar_position: 5
---

# Hubstaff integration

How tracked time gets from Hubstaff into `time_entries`, ready for approval and pay
calculation. This is stage 2 of the [Pay pipeline](./pay-pipeline.md).

## Authentication

The client (`src/server/hubstaff/client.ts`) authenticates with a **rotating refresh token**:

- `HUBSTAFF_REFRESH_TOKEN` (server-only) is exchanged at `https://account.hubstaff.com/access_tokens`
  for an access token. `HUBSTAFF_API_BASE` overrides the API base (default
  `https://api.hubstaff.com/v2`; used to point at a mock in tests).
- `getAccessToken()` caches the access token in the `api_tokens` table and reuses it while it has
  > 5 min of life. **Hubstaff rotates the refresh token on every exchange**, so the new one is
  persisted back (best-effort — a failed save doesn't abort the sync).
- `pageAll()` walks cursor-paginated responses with a safety cap (~50 pages).

## The sync

The single source of truth is `syncHubstaffForCompany(db, companyId, opts)`
(`src/server/hubstaff/service.ts`). `opts` resolves a window via `resolveWindow()`: explicit
`start`/`stop`, or a `lookbackDays` rolling window (0–31, default 3). Hubstaff's daily-activities
API is capped at **31-day** windows.

Step by step:

1. Resolve the company's `hubstaff_org_id` (throws if unconfigured) and a valid access token.
2. Pull **daily activities** and (best-effort) **PTO / time-off requests** for the window.
3. Accumulate per-user-per-day totals — pure: `accumulateActivities()` and `accumulatePto()`
   in `src/lib/hubstaff/transform.ts`. (PTO is merged regardless of its `paid` flag — a
   preserved legacy invariant.)
4. Build a **worker match index** (`buildWorkerMatchIndex()`) from employer-wide
   `worker_companies` links, with three priority tiers: numeric `hubstaff_user_id` → strict name
   key → loose name key (`nameKey`/`looseKey` from `src/lib/names`).
5. Resolve a stable `source_name` per worker (`resolveSourceName()`, using
   `fetchCanonicalSourceNames()`) so re-syncs hit the same upsert key.
6. Run the pure `transformActivities()`: match each user to a worker, skip unmatched (collected
   into `unmatched[]`), and emit rows.
7. **Upsert** via `upsertTimeEntries()` on the conflict key **`(company_id, source_name, work_date)`** —
   the same key the CSV importer uses, so re-running is idempotent. Rows land at
   `approval = 'pending'` with an `import_batch_id`.
8. Persist any newly-resolved `hubstaff_user_id` back to `worker_companies` so future syncs match
   by id first.

### Decided-day protection & divergence

Once a day is **decided** (`approval` is `approved` or `rejected`), the sync **never overwrites
it**. `buildDecidedSets()` freezes those rows. If Hubstaff later reports different seconds for a
decided day, that's surfaced as a **divergence** (logged as a `time_divergence` audit event, up
to 100) — the row is *not* changed; an admin must re-open and correct it. This is the "F3"
invariant.

### Unmatched names

Users whose Hubstaff name matches no worker produce no row and are returned in `unmatched[]`
(surfaced in the UI). When a worker is matched **by name** but has no stored `hubstaff_user_id`,
the id is persisted after the run so the next sync matches by id directly.

## Manual vs scheduled

| Path | Trigger | Entry |
|---|---|---|
| **In-app** | Admin clicks "Sync from Hubstaff" on `/imports` | `syncHubstaffNow()` / `importHubstaffTime()` (`src/server/actions/hubstaff*.ts`) — admin-gated; supports explicit range or 3-day default |
| **Scheduled** | Nightly cron | Supabase **`hubstaff-sync`** Deno edge function (gated by `x-cron-secret`, `verify_jwt = false`), 3-day rolling lookback |
| **CSV** | Manual upload | `importCsvBatch()` (`src/server/actions/time.ts`) — parses a Hubstaff CSV, same upsert key |

All three share the pure transform. `listHubstaffOrgs()` populates the org picker on the import
dialog.

## Time approval

Imported rows are `pending` until an admin decides them:

- `setTimeApproval()` (`src/server/actions/time.ts`) sets `approved`/`rejected`, stamping
  `approved_at`/`approved_by` on approve and clearing them on reject (the "F8" timing invariant).
  It snapshots prior values for undo.
- `undoApproval()` restores the prior state.

Only **approved** time counts toward pay. `time_entries` columns touched: `company_id`,
`worker_id` (nullable until attributed), `source_name`, `work_date`, `tracked_seconds`,
`pto_seconds`, `activity_pct`, `approval`, `import_batch_id`. From here, approved time feeds
[Calculate](./pay-pipeline.md) — paid PTO counts as worked (see [Money core spec](./money-core-spec.md)).
