# Proposal — Coverage-gap detection

**Status:** awaiting decision · **Audit refs:** 05-gaps §2.3, §4.1; 00-summary Goal 9

## Problem (OBSERVED)

The Overview computes **payroll-readiness** only (`src/db/queries/overview.ts`): time
pending approval, missing rate/payout-method, locked-not-sent periods, doc reviews. It
**cannot** flag a *coverage* gap — "a contractor who was expected to work this period but
didn't," or "a client whose expected sessions weren't delivered" — because **no expected
coverage target is stored or compared to actuals**. `worker_companies.weekly_hours` exists
(`numeric`, informational) but is never compared to anything.

So a "gap" is uncomputable today: the Overview can only flag missing *config*, not missing *work*.

## Two definitions of "coverage" (pick the intended grain — INFERRED, needs confirmation)

1. **Contractor-hours coverage** — each active `worker_companies` link has an expected
   `weekly_hours`; compare to actual tracked time (`time_entries.tracked_seconds`) for the
   period. Flag *under-coverage* (worked ≪ expected) and *zero-time-but-expected*.
2. **Client/session coverage** — each client (or child case) has an expected number of
   sessions per period; compare to approved `service_sessions`. Flag *missing visits*.

These are independent and could both ship; #1 is the higher-value, lower-cost starting point
because the target column (`weekly_hours`) **already exists**.

## Recommended shape — two phases

### Phase 1 — derive from existing data, NO new schema (ship first)
Compute expected period hours = `worker_companies.weekly_hours × weeks_in_period`, compare to
`Σ time_entries.tracked_seconds` for that worker+period, and add an Overview "Coverage" signal:
- **Zero-time-but-expected:** active link with `weekly_hours > 0` and 0 tracked hours in the period.
- **Under-coverage:** tracked hours < (e.g.) 60% of expected — threshold configurable.

Pure function `classifyCoverage(links, actuals, period, threshold)` (testable, mirrors the
existing `classifyExpiry`/`classifyHiringReview` pattern) + an overview query + a card. This
delivers the capability immediately using data that already exists, and is fully reversible.

### Phase 2 — `coverage_targets` table (only if Phase 1 isn't enough)
Add a real target model when per-period overrides, session targets, or planned-leave handling
are needed beyond a single `weekly_hours` number:

```sql
create table public.coverage_targets (
  id            uuid primary key default gen_random_uuid(),
  worker_id     uuid not null references public.workers(id) on delete cascade,
  company_id    uuid references public.companies(id) on delete cascade,  -- null = employer-wide
  period_kind   text not null check (period_kind in ('weekly','semi_monthly')),
  target_hours  numeric check (target_hours is null or target_hours >= 0),
  target_sessions integer check (target_sessions is null or target_sessions >= 0),
  effective_from date not null,
  effective_to   date,   -- null = open-ended; CHECK (effective_to is null or effective_to >= effective_from)
  note          text,
  created_at    timestamptz not null default now()
);
-- one open target per (worker, company, period_kind): partial unique index on effective_to IS NULL
-- RLS: admin read/write scoped via the same company-scope helper as worker_companies.
```
Planned leave (a contractor legitimately off) would either reuse the existing PTO data or add a
`coverage_exceptions` row so leave doesn't read as a false gap.

## Decision needed
- **Grain:** contractor-hours, client-sessions, or both?
- **Scope:** Phase 1 only (use `weekly_hours`, no new schema), or commit to the full
  `coverage_targets` model now?
- **Thresholds:** what under-coverage % counts as a gap, and should it be configurable?
