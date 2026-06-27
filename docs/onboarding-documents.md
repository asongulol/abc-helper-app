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

## Agreements

Agreement bodies are templates with `{{token}}` placeholders. Merge logic is pure and
XSS-hardened in `src/lib/agreements/merge.ts`:

- `mergeAgreement()` fills placeholders and appends the engagement type + a DST note.
- Prefill values are staged on `onboarding_agreements` by `editAgreementPrefill()`
  (`src/server/actions/onboarding.ts`): `f_position`, `f_rate` (semi-monthly), `f_start_date`,
  `f_company_name`, `f_employment_type`, `f_hours_per_week`, `f_schedule`.
  `monthlyFromPeriod()` derives the monthly figure (× 2) for display.
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
