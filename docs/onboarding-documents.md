---
title: Onboarding & documents
sidebar_position: 4
---

# Onboarding & documents

How a hired contractor becomes a fully onboarded, payable worker — the three-stage wizard,
agreement signing + admin countersign, document upload + review, and the expiry/hiring
reminder digests. This is stage 1 of the [Pay pipeline](./pay-pipeline.md).

## The three stages

A contractor's progress lives in `onboarding_progress` (one row per worker; type
`OnboardingProgressRow` in `src/db/queries/onboarding.ts`). `currentStage` advances through:

| Stage | Name | What the contractor does | Completion check |
|---|---|---|---|
| 1 | **Sign** | Sign 4 agreements: `ic_agreement`, `non_compete`, `confidentiality_nda`, `baa` | `canAdvanceFromStage1()` — all required kinds signed |
| 2 | **Profile** | Fill the profile form (contact, address, education, payout methods) | per-tab `completeOnboardingTab()` |
| 3 | **Documents** | Upload required docs: `resume`, `diploma`, `nbi_clearance`, two-sided `gov_id` | `isStage3Complete()` — every required kind approved/waived/deferred, both sides present |

Stage derivation is pure: `deriveStageInfo()` (`src/lib/onboarding/progress.ts`) turns the
progress row into a label, tone, and percent for the UI. When all three complete, `completedAt`
is set and the RLS helper **`is_onboarded()`** returns true — which is what unlocks the Time and
Sessions tabs in the [portal](./portal.md).

**Admin overrides** (`src/server/actions/onboarding.ts`): `setOnboardingStage()` toggles a
single stage, `markOnboardingComplete()` forces completion, `resetOnboarding()` returns to
stage 1. `seedOnboardingProgress()` (`src/db/queries/onboarding.ts`) creates the initial row
when a portal login is provisioned.

## The queue (`/onboarding`)

**Onboarding & contracts** is the one place to chase signatures and documents, in two tabs that
each count the contractors with at least one open item:

- **New hires** — `onboarding_progress` rows still in progress (stage 1–3, or reopened). "Show
  completed" reveals the rest.
- **Current team** — every active contractor whose onboarding is not in progress and who still
  owes something: a contract drafted / sent / signed-awaiting-countersign, no IC agreement in the
  app (the **Onboard current** wizard is their action when they have no portal login), or a
  document pending review / needing replacement / deferred and due / expired or expiring within
  30 days. One row per contractor; the row opens the contractor profile. `deriveOpenItems()`
  (`src/lib/onboarding/current-team.ts`) is the pure rule, fed by `fetchCurrentTeam()`.

The Overview "Countersign N" duty counts contractor-signed contract versions alongside signed
agreements. `/onboarding?tab=team` deep-links to the second tab.

## Agreements

Agreement bodies are templates with `{{token}}` placeholders. Merge logic is pure and
XSS-hardened in `src/lib/agreements/merge.ts`:

- `mergeAgreement()` fills placeholders and appends the engagement type + a DST note.
- Prefill values are staged on `onboarding_agreements` by `editAgreementPrefill()`
  (`src/server/actions/onboarding.ts`): `f_position`, `f_rate` (semi-monthly), `f_start_date`,
  `f_company_name`, `f_employment_type`, `f_hours_per_week`, `f_schedule`.
  `monthlyFromPeriod()` derives the monthly figure (× 2) for display. This is the **version 1**
  IC agreement only; any later change to a rendered term is a new
  [contract version](#contract-versions), never an edit of a signed document.
- Drawn signatures are validated on two paths: `signAgreement()` checks an inline
  `data:image/(png|jpe?g|webp);base64,…` regex with a **1 MB** cap; `safeSigImg()`
  (`src/lib/agreements/merge.ts`, ≤ ~1.4 MB, no quotes/`<`) is the **render-time** XSS guard used
  by `renderAgreementParts()`.
- `renderAgreementParts()` returns structured, escape-safe parts for JSX rendering.

### Signing + countersign

1. **Contractor signs** in order via `signAgreement()` (`src/server/actions/portal.ts`): the
   four agreements must be signed sequentially. The signature lands in `onboarding_signatures`
   (`signature_method` drawn/typed, `signature_data`, `signed_at`, `ip_address`, `user_agent`).
   `signature_data` is **PHI** — encrypted at rest via `src/server/crypto` (see below).
2. **Admin countersigns** via `countersignAgreement()`. This requires the admin's
   **`can_countersign`** flag (`admin_users.can_countersign` → `CurrentAdmin.canCountersign`),
   the contractor must have already signed, and once countersigned it's immutable. If one admin
   is assigned as countersigner, only that admin may complete it.

## Contract versions {#contract-versions}

Rehiring a former contractor, changing a current contractor's rate or terms, and re-issuing an
agreement are one feature: a **new version of the IC agreement** that the contractor signs and an
admin countersigns. The signed document, the `worker_companies` row and the effective-dated rate
are one unit — none changes without the others. Decisions and history: the
[Contract versions plan](./CONTRACT-VERSIONS-PLAN.md). Only the IC agreement is versioned;
non-compete, NDA and BAA stay once-per-worker.

```
draft ──send──▶ sent ──sign──▶ signed ──countersign──▶ active ──▶ superseded (next countersign)
  │              │               │                                └─▶ ended     (termination)
  └──────────────┴───────────────┴── void (admin only; a signature on it → status 'superseded')
```

Rows live in `contract_versions` (see [Data model](./data-model.md#contract-versions)); every
current engagement's **version 1 is a read-through** of the legacy `ic_agreement` row + its
`doc_version='1'` signature, so rows start at 2. Actions in `src/server/actions/contracts.ts`
(all admin actions require `can_countersign` + company scope; Zod schemas in
`src/types/schemas/contracts.ts`):

| Step | Action | What happens |
|---|---|---|
| Draft | `draftContractVersion()` | Insert prefilled from `contractOfRecord()` — or from the version just **voided**, so a fix to an unsigned document isn't retyped; `effective_from` defaults to the next period start. A draft is edited in place (drafts are free). Refused while a version is `sent`/`signed`. |
| Send | `sendContractVersion()` | Freezes the document: `renderAgreementParts`-style merge of **today's** template + the version's terms + one merge line ("takes effect on X and supersedes the agreement dated Y") → `rendered_body`, `doc_sha256`. Guarantees a portal login (`createPortalLogin` if none, `restorePortalLogin` if revoked), emails `contract_review`. The engagement stays `ended` on a rehire until countersign. |
| Sign | `signContractVersion()` (contractor, `requireWorker`) | Same scroll-to-end + typed/drawn contract as `signAgreement()`. Inserts an `onboarding_signatures` row with `doc_version=String(N)` and the frozen `doc_sha256`; PHI encrypted as usual. A second sign **errors** (plain insert, not an ignore-duplicates upsert). |
| Countersign | `countersignContractVersion()` | The "one unit" write, sequential with `hireContractor`-style undo-in-reverse rollback: (1) `executeRateUpsert` at `effective_from` (the planner closes the prior open rate the day before), (2) `worker_companies` contract/hours/role — a rehire reopens the link and the worker from `start_date` (**not** `reactivateWorkerLink`, which would reopen the old rate), (3) the `active` prior → `superseded`, `ended_on = effective_from − 1` (an `ended` prior keeps its termination date), (4) this version → `active` + `countersigned_*`, (5) `contract_countersigned` email with the portal print link. |
| Void | `voidContractVersion()` | Any in-flight version. A signature on it becomes `superseded`. Re-revokes the login when the worker is `ended` and fully paid — the same predicate as the nightly sunset sweep. |

**Clause values that vary by position** are merge tokens on the version, never edits to the
document and never per-position templates. The first is the Section 11.1 termination notice:
`contract_versions.notice_days` renders as `{{notice_days}}` (migration `00000000000046` swapped
the template's hard-coded "fifteen (15)" for the token). `mergeAgreement()` defaults it to
`DEFAULT_NOTICE_DAYS` (15), so the version 1 read-through and the onboarding sign page read
exactly as before. Add another token only when a real contract needs a different value.

**What else moves with a version**

- **Termination** (`endEngagement`, under both `terminateContractor` and `endAssignment`) stamps
  the `active` version `ended` with `ended_on = last day`. No document, no signature.
- **Rate corrections** (`saveRate`): once a versioned contract is `active`, the editor is
  **owner-only** and the amount must equal the contract's `rate_php` — it fixes an effective
  date, never the amount. "Change the rate" means a new contract. Engagements still on v1 keep the
  free editor; the profile's rate card shows **New contract** instead.
- **Portal access exceptions**: the nightly `sunsetPortalLogins` sweep and the portal resolver
  (`src/server/auth/worker.ts`) both keep a departed, fully-paid contractor's login alive while a
  version is `sent`/`signed`, so a rehire can sign. Send restored it on purpose.
- **Backpay for a backdated effective date** (a late review): countersign writes the rate from
  `effective_from`, so periods already **paid** at the old rate are owed the difference. The
  Contracts tab shows a quote (`getContractBackpay`) the admin confirms (`addContractBackpay`); it
  lands as `off_cycle_pay_items` rows with `basis='backpay'` on the **next open regular period**.
  Pricing is pure (`src/lib/pay/backpay.ts`): `paid × (new − old) / old × fraction`, the first
  period prorated by **working days** on/after the effective date, never negative. Salaried
  catch-up rows on those periods are included; a locked-but-unpaid period is excluded with a
  warning (unlock + recalc is the fix). Service: `quoteContractBackpay` /
  `addContractBackpayEntry` in `src/server/off-cycle.ts`.

**Where it shows**: the admin profile's **Contracts** tab
(`src/components/contractors/profile/ContractsTab.tsx`) — version list, draft form, Send / Void /
Countersign / Print, the backpay quote; the roster's "Awaiting signature · N days" badge on
`sent`; the portal's **Contracts** tab (see [Contractor portal](./portal.md#contracts)). Print
pages render the frozen `rendered_body` (`src/components/print/ContractVersionPrint.tsx`) at
`/contracts/[versionId]/print` (admin) and `/portal/contracts/[versionId]/print` — **never** the
live template. No FX on any of it.

Known ceiling: `doc_version` is per worker, not per engagement, so two companies at the same
version number would collide on the signature unique key. No worker has two engagements today.

## Documents

The `documents` table (`DocumentRow` in `src/db/queries/documents.ts`) holds uploads with a
`kind` (e.g. `gov_id`, `nbi_clearance`, `resume`, `diploma`, `w8ben`, `ic_agreement`, `other`),
an optional `side` (`front`/`back`), and a **`review_status`**:

```
pending → approved
        → needs_replacement   (contractor must re-upload)
        → waived              (admin waives a required doc forever)
        → deferred            (admin defers; expires_on is the re-check date)
```

**Upload (contractor)** — `uploadOwnDocument()` (`src/server/actions/portal-docs.ts`):
validates type (PDF/JPG/PNG) and size (≤ 10 MB), uploads to the **`contractor-docs`** Supabase
storage bucket at `{userId}/{kind}/{timestamp}-{side?}-{name}`, and inserts a `documents` row at
`review_status='pending'`. NBI clearance requires an `issuedOn` date.
`fetchOutstandingDocSlots()` tells the contractor what's still owed, built from
`portal_settings.onboarding_config.documents` (falling back to a default required-doc list when
none are configured).

**Review (admin)** (`src/server/actions/portal.ts`) — `reviewDocument()` approves or flags
`needs_replacement` (with a reason); `resolveMissingDocument()` waives/defers a doc that was never
uploaded (a "fileless" row with `storage_path = null`); `clearMissingDocumentResolution()` reverts
that. Each of these review actions triggers `recomputeStage3()` (the contractor upload does not). The checklist itself is computed purely by `deriveDocChecklist()`
(`src/lib/onboarding/documents.ts`), which expands required docs into per-side slots and resolves
the latest upload per slot.

### PHI encryption

Signature data is encrypted with app-layer envelope encryption (`src/server/crypto/index.ts`):
`encryptIfConfigured()` on write, `decryptIfNeeded()` on read (legacy plaintext passes through).
The key provider is `local` (a base64 32-byte `PHI_LOCAL_MASTER_KEY`) or `aws` (KMS via
`PHI_KMS_KEY_ID`), selected by `PHI_KMS_PROVIDER`. See [Architecture](./architecture.md#environment--secrets).

## Reminder digests (cron)

Two scheduled jobs nudge admins about documents. Both authenticate with the `x-cron-secret`
header (`isValidCronRequest()` against `CRON_SECRET`).

**Document expiry** — `POST /api/cron/doc-expiry` (`src/app/api/cron/doc-expiry/route.ts`) calls
`runExpiryCheck()` (`src/server/documents/service.ts`). The pure `classifyExpiry()`
(`src/lib/documents/expiry.ts`) buckets active-worker docs with an `expires_on` into **overdue**
(`days < 0`) and **expiring soon** (`0 ≤ days ≤ withinDays`, default 30), and emails an HTML
digest to `GMAIL_USER`. Fileless waived/deferred placeholders can't expire.

**Hiring review** — `runScheduledHiringReviewDigest()` reads
`portal_settings.onboarding_config.reminders` (`enabled`, `frequency`, `include_deferred`,
`send_to`). `shouldSendDigestToday()` (`src/lib/documents/digest-schedule.ts`) gates by frequency
(`daily`/`weekdays`/`weekly`, fail-open). `classifyHiringReview()`
(`src/lib/documents/hiring-review.ts`) groups onboarding docs (`resume`, `diploma`,
`nbi_clearance`, `gov_id`) into **pending** and **deferred** per contractor for the digest.

Email delivery is best-effort — a missing `GMAIL_USER`/`GMAIL_APP_PASSWORD` makes it a no-op,
not an error (see [Local development](./local-development.md), where Inbucket catches mail).
