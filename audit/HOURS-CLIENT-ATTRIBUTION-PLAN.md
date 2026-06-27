# Plan — Hours → client attribution + per-client invoicing (steps 2–3)

Status: **Phase 2a + most of 2b SHIPPED.** Step 1 (employer-scope the tracker) ✅; Phase 2a
(assigned-client display + ambiguity/double-bill flags) ✅; Phase 2b core ✅ — see "Shipped" below.
Only the automatic Hubstaff per-project sync remains (gated on the Hubstaff API).

### Shipped (Phase 2b)
- Migration `00000000000023`: `time_entries.client_company_id` (the CLIENT hours bill to) + index.
- **Invoicing closes the double-bill** (`fetchEmployerTrackedSeconds` + `computeForClient`): a
  contractor's hours bill to `client_company_id`; a single-client contractor's NULL hours resolve to
  their one client; a multi-client contractor bills ONLY explicitly-attributed hours (others flagged,
  never double-billed). Verified: a 3-client contractor's 10h split 6h+4h across two clients (billed
  once), not 10h to each.
- **Manual hours** (`AddUnlistedRow` + `addHoursTotal/Daily`): a **Client (billed)** picker writes
  `client_company_id`; single-client contractors default automatically.
- Pay unchanged (ratio sums all the contractor's hours across clients).

### Remaining (deferred — needs the Hubstaff API)
The Hubstaff sync still writes `client_company_id = NULL` (correct default). Single-client hours resolve
at read time; multi-client Hubstaff hours must be attributed via the manual picker until the sync is
taught to split per-project (project→client map already exists; confirm the per-project daily endpoint).

## Problem (confirmed with product)

- Pay (employer → contractor): mostly the **salaried ratio** model (worked ÷ expected hours × rate);
  a minority are per-session / per-hour.
- **Invoice (client ← employer): ACTUAL hours worked for that client × bill rate.**
- A contractor **serves multiple clients.**

### The bug (real, must-fix)
`computeInvoice` ([src/lib/invoicing/compute.ts](../src/lib/invoicing/compute.ts)) builds each
client's hourly lines from **that client's roster × the worker's _total_ employer hours**
(`fetchEmployerTrackedSeconds` sums *all* of a worker's `tracked_seconds`, no client/project filter —
[src/db/queries/invoicing.ts:192](../src/db/queries/invoicing.ts)). So a contractor on two clients'
rosters has their **full hours billed to BOTH clients → double-billing.**

### Root cause
Time is stored aggregated at `(company_id=employer, source_name, work_date)` with **no client**.
The Hubstaff **project → client** map exists (`hubstaff_projects.company_id`) but is never applied,
and the Hubstaff sync aggregates a worker's day **across projects**, discarding the only signal that
could attribute hours to a client.

## Attribution priority (clarified with product)

Resolve the client for a contractor's hours in this order:

1. **App assignment — the FIRST check.** The contractor's active worker→client link(s)
   (`worker_companies.kind='client'`). **Today every contractor is assigned to exactly ONE client**
   (Ability Builders *or* 123 Baby Talks), so **all their hours bill to that client** — no Hubstaff
   parsing needed.
2. **Hubstaff project membership — multi-client only.** Each Hubstaff project's membership maps to a
   client (123 Baby Talks / ABC = Ability Builders). Used **only when a contractor serves >1 client**
   to split hours per project → client.

**Therefore the "double-bill" is a _future guard_, not a live incident:** with one client per
contractor the existing roster-driven invoice already bills correctly. The work below makes
attribution explicit (so it stays correct when contractors go multi-client) and surfaces it in the
tracker.

## Goal
Attribute each block of hours to the client it was worked for, so:
- **Invoice** = Σ (that client's hours) × bill rate — actual hours, no double count.
- **Pay (ratio)** = Σ all the worker's hours — unchanged.
- **Manual hours** capture a client (like sessions already do).

## Approach — staged

### Phase 2a — NOW (single client per contractor): make attribution explicit + safe
Small, no Hubstaff changes:
- **Resolve each worker's billing client = their single active client link.** Surface it in the
  tracker (a "Client" shown per contractor) so it's obvious who bills where.
- **Guard the invoice:** when a worker has **exactly one** active client link, bill their hours to it
  (today's behavior, now explicit). When a worker has **0 or >1** active client links, **flag it**
  ("ambiguous — needs per-project attribution") instead of silently billing total hours to every
  client. This is the cheap insurance against the future double-bill.
- No schema/sync change required yet.

### Phase 2b — WHEN a contractor serves multiple clients: per-project attribution
The fuller build (below) only becomes necessary once a contractor is assigned to >1 client.

### A. Time granularity — capture hours per (worker, work_date, client)
**A1 (recommended):** add `client_company_id uuid NULL` (FK companies) to `time_entries`; the import
writes one row per (worker, work_date, project→client); change the idempotency key from
`(company_id, source_name, work_date)` → `(company_id, source_name, work_date, client_company_id)`.
Pay sums across clients; invoice filters by client. Least churn.

A2 (alt): a separate `time_entry_clients(worker, work_date, client, seconds)` allocation table — more
normalized but more surface and a second write path. Not recommended.

### B. Hubstaff sync → per-project hours ([supabase/functions/hubstaff-sync](../supabase/functions/hubstaff-sync/index.ts))
- Fetch time **per project** (Hubstaff activities/projects daily endpoint) rather than the worker's
  daily aggregate.
- Resolve project → client via `hubstaff_projects.company_id`.
- Write per (worker, work_date, client). **Unmapped project → `client_company_id = NULL`**, surfaced
  in the tracker as "hours not attributed to a client" so the admin maps the project.
- Confirm/extend the **project→client mapping admin UI** (a `hubstaff_projects` config screen).
- ⚠️ **Confirm the Hubstaff plan exposes per-project daily time** for this org during implementation.
  Fallback if not: admin allocates a worker's daily hours across clients, or projects are 1:1 with a
  worker's single client.

### C. Invoicing fix ([invoicing.ts](../src/db/queries/invoicing.ts) + [compute.ts](../src/lib/invoicing/compute.ts))
- `fetchEmployerTrackedSeconds` → add `.eq('client_company_id', clientId)` so it returns only the
  hours worked for that client.
- `computeInvoice` math is unchanged — it just receives the client-filtered hours.
- Net effect: each client billed for *its* actual hours. Closes the double-bill.

### D. Manual hours entry (tracker) ([AddUnlistedRow.tsx](../src/components/time/AddUnlistedRow.tsx))
- Add a **client picker** (the worker's assigned clients, reuse `getWorkerClients`) to the add-hours
  row; write `client_company_id`. Pay still sums; invoice attributes.

### E. Pay path — unchanged
- `fetchApprovedTime` / the ratio calc sum a worker's seconds across the period; with per-client rows
  it must sum across `client_company_id` values (verify the group-by is by worker, not by client).

### F. Tracker display
- Show each contractor's hours **grouped by client**; flag any hours with `client_company_id IS NULL`
  (unmapped project) for the admin to resolve. This is the "best format" answer: employer-scoped,
  hours-per-client, one approve → pay + invoice.

### G. Migration + backfill
- Migration: add `time_entries.client_company_id` + the new unique index (drop/replace the old key).
- **Backfill:** existing aggregated rows have no project signal → `client_company_id` stays NULL;
  a re-sync (post-change) repopulates with attribution. Historical pre-change hours can't be
  retroactively attributed — document this.
- ⚠️ Local/CI migration only; the prod copy is hand-applied via the Dashboard (disjoint history).

## Risks / decisions to confirm before building
1. **Hubstaff per-project endpoint** availability (B) — the linchpin; confirm first.
2. **time_entries key change** — affects sync idempotency and any code assuming one row per
   (worker, day). Audit call sites.
3. **Backfill** — historical hours can't be split; agree they stay employer-only / unattributed.
4. **Approval granularity** — approve per (worker, day) still, or per (worker, day, client)?

## Verification
- Seed a multi-client contractor with hours on 2 projects→2 clients; confirm each client's invoice
  bills only its hours, and the pay ratio uses the summed total.
- Tests: `computeInvoice` per-client filtering; import project→client resolution; manual-hours client;
  a regression test pinning the double-bill fix.

## Out of scope (already done)
- Employer-scoping the tracker, per-session entry, off-cycle session pay + dedup.
