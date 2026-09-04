# Contract versions — rehire, modify, re-issue

> **Status:** PLAN ONLY. No code/schema changes made. Written 2026-09-04 after a decision
> interview with the owner. Every numbered decision below was put to the owner and confirmed.
> **Covers:** rehiring a previous contractor, changing the terms of a current contractor,
> sending a new contract to a current contractor. All three are the same feature.

---

## 0. Decisions (confirmed)

1. **A contract is one unit.** The signed IC agreement, the `worker_companies` row, and the
   effective-dated `rates` row move together. None of them changes without the others.
2. **Any change to a rendered field creates a new version** that the contractor signs and an
   admin countersigns. Rendered fields: rate, position, start date, employment type, schedule,
   hours per week, company name. Signed versions are never edited in place. Drafts are free.
3. **Only the IC agreement is versioned.** Non-compete, NDA, BAA stay once-per-worker.
4. **Versions live in a new table** (`contract_versions`). The existing
   `onboarding_agreements.ic_agreement` row + its `doc_version='1'` signature is read as
   **version 1** for every current worker. No backfill. Signatures keep using
   `onboarding_signatures`; `doc_version` carries the real version number from 2 onward.
5. **Countersign makes a version the contract of record.** Each version carries an
   admin-set `effective_from`, defaulting to the next pay period start. Countersign writes the
   rate row, updates the engagement row, and supersedes the prior version as of the day before.
6. **Send** freezes terms + rendered body, guarantees an active portal login (create or
   restore), emails a notice, and puts the pending version first in the portal. The engagement
   stays ended until countersign. Void re-revokes a login that send restored.
7. **Rehire redoes only the IC agreement and tool setup.** Profile and documents stay on
   file. The rehire path does **not** reopen the old closed rate (`reactivateWorkerLink` is
   not used); the new version writes its own.
8. **The pay-tab rate button becomes "New contract".** Direct rate edits are corrections
   only, defined as moving the rate row *toward* the contract of record. Engagements with no
   versioned contract keep the free editor.
9. **One version in flight per engagement.** Admin-only void. No contractor decline.
10. **Legacy portal is left untouched.** It keeps rendering the version-1 row. Feature does
    not wait for cutover.
11. **Termination stamps the current version** (`ended_on`, status `ended`). No document,
    no signature.
12. **Every version is a full replacement agreement** rendered from the single existing
    `ic_agreement` template, plus one merge line: effective date and "supersedes the
    agreement dated X".

Assumed without asking (owner may override):
- Draft/send/void/countersign use today's countersign permissions. Rate correction is owner-only.
- Version numbers count per engagement (worker + company). A move to another company starts at 1 there.
- Contractor sees superseded versions read-only in the portal and gets an email with a print link at countersign.
- `hireContractor` keeps blocking on an existing email; the error links to the profile's "New contract".

---

## 1. Schema (one additive migration, `00000000000044_contract_versions.sql`)

Shared prod DB: additive only, applied via Dashboard SQL per `shared-prod-conformance.md`.
New table, new enum, new indexes, new policies. **No change** to `onboarding_agreements`,
`onboarding_signatures`, `worker_companies`, `rates`.

```
contract_version_status: draft | sent | signed | active | superseded | ended | void

contract_versions
  id              uuid pk default gen_random_uuid()
  worker_id       uuid not null → workers on delete cascade
  company_id      uuid not null → companies
  version         int  not null                      -- 2.. (1 is the read-through)
  status          contract_version_status not null default 'draft'
  -- terms (what renders into the document)
  rate_php        numeric(12,2) not null
  period_basis    text not null default 'semi_monthly'
  position        text, employment_type contract_type, schedule text, hours_per_week int
  start_date      date not null                      -- engagement start (rehire: new one)
  effective_from  date not null                      -- when the terms apply to pay
  addendum_type   text, addendum_text text
  -- lifecycle
  supersedes_id   uuid → contract_versions           -- null when superseding the v1 read-through
  ended_on        date                               -- stamped by termination / supersede
  rendered_body   text                               -- frozen at send
  doc_sha256      text                               -- sha256(rendered_body), copied onto the signature
  sent_at, signed_at, countersigned_at timestamptz
  countersigned_by uuid, countersigned_name text
  voided_at timestamptz, void_reason text
  created_by uuid, created_at timestamptz default now()

unique (worker_id, company_id, version)
unique (worker_id, company_id) where status in ('draft','sent','signed')   -- one in flight
unique (worker_id, company_id) where status = 'active'                     -- one of record
check (effective_from >= start_date)
```

RLS (see memory rule: contractor policies never read `worker_companies`/`companies` directly):
- `SELECT` to authenticated: `worker_id = my_worker_id() OR admin_can_see_worker(worker_id)`
  — same shape as `onboarding_signatures_read`.
- No INSERT/UPDATE/DELETE policies. All writes go through server actions on the service client,
  as signatures do today.

Signature rows for version N: `agreement_kind='ic_agreement'`, `doc_version=String(N)`,
`doc_sha256=version.doc_sha256`. The existing unique key and immutability trigger apply unchanged.

---

## 2. Reads

`contractOfRecord(workerId, companyId)` (new, `src/db/queries/contracts.ts`):
- active `contract_versions` row if one exists, else
- **v1 read-through**: terms from `onboarding_agreements` where `agreement_kind='ic_agreement'`,
  rate from the current open `rates` row (money source of truth), signed/countersigned from the
  existing row + `doc_version='1'` signature. Returned with `version: 1, source: 'legacy'`.

Draft prefill uses `contractOfRecord`. "Has a versioned contract" = `source !== 'legacy'`.

---

## 3. Actions (`src/server/actions/contracts.ts`, new)

| Action | Does | Refuses when |
|---|---|---|
| `draftContractVersion` | insert `draft` prefilled from `contractOfRecord`; `effective_from` defaults to `nextPeriod(todayManila).start` | a draft/sent/signed exists (partial unique) |
| `sendContractVersion` | render body via `renderAgreementParts` (template + terms + supersedes line) → `rendered_body`, `doc_sha256`; `createPortalLogin` if none / `restorePortalLogin` if revoked; send `contract_review` email; `status='sent'`, `sent_at` | status ≠ draft |
| `voidContractVersion` | `status='void'`; signature (if any) → `status='superseded'`; if worker is `ended` and send restored the login → `revokePortalLogin` | status ∈ active/superseded/ended |
| `signContractVersion` (in `portal.ts`, next to `signAgreement`) | same scroll+sign contract as today; upsert signature with `doc_version=String(version)`, `doc_sha256`; `status='signed'`, `signed_at` | status ≠ sent; `scrolledToEnd` false |
| `countersignContractVersion` | see §4 | status ≠ signed |

`endEngagement` (`src/db/queries/workers.ts:540`) — the shared path under both `terminateContractor`
and `endAssignment` — gains one update: active version for that engagement →
`status='ended', ended_on=lastDay`. One place, both callers covered.

`sunsetPortalLogins` (`workers.ts:769`) — exclude workers with a version in `sent`/`signed`.
Without this the nightly sweep re-revokes a rehire's login the night after send.

`saveRate` (`payroll.ts:122`) — when the engagement has an active version: owner-only, and the
resulting amount must equal `rate_php`. Otherwise unchanged. (Effective-date corrections pass;
amount changes away from the contract are rejected with "issue a new contract".)

---

## 4. Countersign write-through (the "one unit" moment)

Sequential, with the `hireContractor` rollback pattern (undo in reverse on failure):

1. `rates`: `executeRateUpsert(planRateUpsert(...))` with `effective_start=effective_from`.
   The planner already closes the earlier open rate at `effective_from - 1`.
2. `worker_companies`: `contract`, `weekly_hours`, `role`, `pay_basis` from the version.
   If the link is `ended` (rehire): `status='active'`, `started_on=start_date`, `ended_on=null`,
   `workers.status='active'`. The DB trigger then restores the login if it was still revoked.
3. Prior version (`supersedes_id`, or nothing for the v1 read-through): `status='superseded'`,
   `ended_on=effective_from - 1`.
4. This version: `status='active'`, `countersigned_*`.
5. Rehire only: `set_tools_requested` RPC (termination wiped `worker_tools`).
6. Email `contract_countersigned` with the print link. Audit row `contract.countersigned`.

Do **not** call `reactivateWorkerLink` — it reopens the old rate by `effective_end = lastDay`,
which would collide with step 1.

---

## 5. UI

Admin
- Contractor profile: **Contracts** section — version list (status, effective date, signed/countersigned),
  buttons: New contract / Send / Void / Countersign / Print.
- `PayTab.tsx` rate change button → opens New contract when a versioned contract exists;
  legacy engagements keep the editor.
- Roster (`ContractorsClient.tsx`): "Awaiting signature · N days" badge on `sent`.
- `hireContractor` duplicate-email error text links to the worker's profile.

Portal
- `onboarding/page.tsx`: if a `sent` version exists, it is the first (and only) pending item,
  reusing the stage-1 scroll-to-end + sign component.
- Print page for a version renders `rendered_body`, **not** the live template.
- Read-only contract history (current highlighted). No FX anywhere on it (owner rule).

Email templates (`src/server/email/templates.ts`): add `contract_review`, `contract_countersigned`
to the editable defaults.

---

## 6. PR slices (each commit-clean; stop and report after each)

1. **Schema + reads + stamps.** Migration, `src/db/types.ts` regen, `contracts.ts` queries,
   `contractOfRecord`, `endEngagement` stamp, sunset exclusion. Check: one test that the
   one-in-flight index rejects a second draft; one that `endEngagement` stamps.
2. **Draft / send / void + admin UI.** Actions, profile Contracts section, roster badge, emails.
   Check: send restores a revoked login; void re-revokes it only when send restored it.
3. **Portal sign + frozen print + history.** Check: signature row carries `doc_version=N` and
   the sha256 of `rendered_body`; a second sign is rejected, not silently ignored.
4. **Countersign write-through + rate guard.** §4 in full; `saveRate` correction rule.
   Check (money path): countersign writes the rate at `effective_from` and closes the prior one
   the day before; rehire sets `started_on` and leaves the old rate closed; correction away
   from the contract is rejected.
5. **Docs.** `data-model.md`, `onboarding-documents.md`, `portal.md`; regen server-actions reference.

Prod apply: migration via Dashboard SQL after grepping the three sibling apps (new objects only,
so no conflict expected). Edge functions untouched.

---

## 7. Out of scope (decided)

- Re-signing non-compete / NDA / BAA when their template changes (separate feature).
- Amendment/addendum documents. `addendum_text` on a version covers one-off clauses.
- Termination letters or separation agreements.
- Mirroring current terms into the legacy portal's row.
- Multiple engagements at the same company (engagement history lives in versions instead).
