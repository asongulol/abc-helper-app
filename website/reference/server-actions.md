---
title: Server actions
sidebar_position: 2
---

# Server actions

This is the app's **real mutation API**. ABC Helper does not expose a REST CRUD
surface — almost every write goes through a [Next.js Server
Action](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations)
(`'use server'`) invoked directly from a client component. (The only true HTTP
routes are the two cron jobs and the auth callback; see the OpenAPI reference.)

Every action follows the same contract:

- **Re-verifies identity on the server.** Admin actions call
  `getCurrentAdmin()` / `requireAdmin()` (and `requireOwner()` for owner-only
  operations); contractor-portal actions call `requireWorker()` /
  `getCurrentWorker()`. The client-supplied identity is never trusted.
- **Validates input with Zod** (a named `*Schema`) or an explicitly typed
  argument object before touching the database.
- **Enforces company scope** where relevant: a non-owner admin may only act on
  companies in `admin.companyIds` (owners bypass). Actions that write through
  the service-role client (RLS bypassed) repeat this check in code.
- **Returns a typed `ActionResult`** — `{ ok: true, data }` on success or
  `{ ok: false, error }` on failure (the no-payload form is just `{ ok: true }`).
  A few read-only files use the equivalent `SimpleResult` / `OnboardingDetailResult`.

For how these fit into the wider system (RLS, service-role client, the audit
log, `revalidatePath` cache invalidation), see the architecture overview at
[/architecture](/architecture).

:::note Auth / scope legend
**admin** = any signed-in admin · **admin (scoped)** = admin + per-company scope
check · **owner** = owner-only (`requireOwner` / `isOwner`) · **worker** =
authenticated contractor (`requireWorker`). "audit: `x`" = writes an audit-log
event named `x` via `logEvent`. "revalidate: `/p`" = calls
`revalidatePath('/p')`.
:::

---

## Contractors & onboarding

Source: `contractors.ts`, `onboarding.ts`.

### `contractors.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `addContractor` | Quick-add a blank contractor and link them to a company | `AddContractorSchema` | admin (scoped) | insert `workers` + `worker_companies` link; audit `add_contractor` |
| `saveWorkerProfile` | Save profile + link fields for an existing contractor | `SaveWorkerProfileSchema` | admin (scoped) | update `workers` + `worker_companies`; audit `edit_contractor` |
| `setContractorLinkStatus` | Deactivate / reactivate a contractor's company link | `SetLinkStatusSchema` | admin (scoped) | update `worker_companies.status`; audit `edit_contractor` |
| `listInvoiceClients` | Active client companies for the hire wizard's invoice picker | — (none) | admin (scoped) | read-only |
| `hireContractor` | Transactional hire orchestrator (workers → link → rate → portal login, with rollback on failure) | `HireContractorSchema` | admin (scoped) | insert/update `workers`, `worker_companies`, `rates`, `onboarding_agreements`, `onboarding_progress`; `set_tools_requested` RPC; creates portal login (→ email) when invited; audit `add_contractor`; revalidate `/contractors`; deletes worker on rollback |
| `setWorkerPhoto` | Persist an uploaded contractor photo path | `{ workerId, path }` | admin | update `workers.photo_url` (service client); audit `edit_contractor`; revalidate `/contractors` |
| `getWorkerPhotoUrl` | Short-lived signed URL for a contractor avatar | `{ workerId }` | admin | read-only; mints `avatars` signed URL |
| `getWorkerCompanies` | All company links for a worker (engagements editor) | `{ workerId }` | admin | read-only |
| `saveWorkerCompanyLink` | Update one company link's role / rates / contract / status | `{ workerId, companyId, role, billRateUsd, sessionRateUsd, contract, payBasis, status }` | admin (scoped) | update `worker_companies` (service client); audit `edit_contractor`; revalidate `/contractors` |
| `assignWorkerCompany` | Assign a contractor to another company (new link) | `{ workerId, companyId }` | admin (scoped) | insert `worker_companies`; audit `edit_contractor`; revalidate `/contractors` |

### `onboarding.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `getOnboardingDetail` | Fetch a contractor's signatures, agreements, documents, checklist & profile for the review panel | `workerId: string` | admin | read-only |
| `setOnboardingStage` | Toggle a single onboarding stage (admin override) and recompute progress | `{ workerId, stage: 1\|2\|3, complete }` | admin | update `onboarding_progress`; audit `onboarding.stage_override`; revalidate `/onboarding` |
| `markOnboardingComplete` | Mark all onboarding stages complete | `{ workerId }` | admin | update `onboarding_progress`; audit `onboarding.mark_complete`; revalidate `/onboarding` |
| `resetOnboarding` | Reset onboarding to stage 1 | `{ workerId }` | admin | update `onboarding_progress`; audit `onboarding.reset`; revalidate `/onboarding` |
| `editAgreementDate` | Edit the signed date on an agreement's signature | `{ workerId, agreementKind, signedDate }` | admin | update `onboarding_signatures`; audit `onboarding.edit_agreement_date`; revalidate `/onboarding` |
| `editAgreementPrefill` | Edit prefilled engagement terms on a prepared agreement | `{ workerId, agreementKind, position?, rate?, startDate? }` | admin | update `onboarding_agreements`; audit `onboarding.edit_agreement_prefill`; revalidate `/onboarding` |

---

## Time & Hubstaff

Source: `time.ts`, `hubstaff.ts`, `hubstaff-sync.ts`, `import.ts`.

### `time.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `setTimeApproval` | Approve / reject time entries; returns prior values for undo | `SetApprovalSchema` | admin (scoped) | update `time_entries.approval`; audit `approve_time` |
| `undoApproval` | Restore previous approval values | `UndoApprovalSchema` | admin (scoped) | update `time_entries`; audit `approve_time` (status `undo`) |
| `addHoursTotal` | Add total hours (total mode → first day of period) | `AddHoursTotalSchema` | admin (scoped) | upsert `time_entries`; audit `manual_hours` |
| `addHoursDaily` | Add per-day hours (days with hours > 0) | `AddHoursDailySchema` | admin (scoped) | upsert `time_entries`; audit `manual_hours` |
| `editContractorTotal` | Rewrite a period total onto the first entry, zero the rest | `EditTotalSchema` | admin (scoped) | update `time_entries`; audit `manual_hours` |
| `importCsvBatch` | Import parsed CSV rows (upsert or skip mode) | `CsvImportSchema` | admin (scoped) | upsert `time_entries`; audit `manual_hours` |
| `deleteImportBatch` | Delete all entries in one import batch (blocked if any date is in a locked period) | `DeleteBatchSchema` | admin (scoped) | delete `time_entries` + empty open `pay_periods`; audit `delete_import` |

### `hubstaff.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `syncHubstaffNow` | On-demand Hubstaff sync from the Time Import screen | `SyncHubstaffSchema` (`{ companyId, periodStart?, periodEnd? }`) | admin (scoped) | Hubstaff API → upsert `time_entries`; audit `hubstaff_sync` |

### `hubstaff-sync.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `listHubstaffOrgs` | List Hubstaff orgs visible to the connected token | — (none) | admin | Hubstaff API read-only |
| `importHubstaffTime` | Pull per-member daily totals for an org + window, stage as pending entries | `ImportHubstaffTimeSchema` (`{ companyId, orgId, start, stop }`) | admin (scoped) | Hubstaff API → upsert `time_entries`; audit `import` |

### `import.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `importContractors` | Bulk contractor import — match existing or create new + company links | `InputSchema` (`{ companyId, preferWiseName?, rows[] }`) | admin (scoped) | insert/update `workers`, `worker_companies`, `rates`; Wise recipient lookup; audit `contractors.bulk_import`; revalidate `/contractors` |
| `fetchImportBatchGroups` | List recent import batches (grouped from `time_entries`) | `companyId: string` | admin (scoped) | read-only |
| `dryRunDeleteRange` | Preview a date-range delete (counts, per-contractor preview, locked-period detection) | `RangeSchema` (`{ companyId, start, stop }`) | admin (scoped) | read-only |
| `deleteImportRange` | Delete time entries in a date range (`confirmText='DELETE'` if it overlaps locked/paid periods) | `RangeSchema` + optional `confirmText` | admin (scoped) | delete `time_entries`, `payments` (open periods in range); audit `delete_import`; revalidate `/imports` |

---

## Payroll

Source: `payroll.ts`, `reconcile.ts`.

### `payroll.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `saveRate` | Save an effective-dated rate (same-day replaces; earlier open rates close) | `RateSaveSchema` | admin (scoped) | upsert `rates`; audit `set_rate` |
| `getRateHistory` | Rate history for a worker in a company (newest first) | `{ workerId, companyId }` | admin (scoped) | read-only |
| `calculatePeriodDraft` | Recalculate a period from tracked hours and save as DRAFT | `CalculateDraftSchema` | admin (scoped) | writes draft `payments` (via service) |
| `restorePaymentsSnapshot` | Undo the most recent recalc by restoring a snapshot (open periods only) | `RestoreSnapshotSchema` | admin (scoped) | restore `payments`; audit `restore_recalc` |
| `getPeriodSummaries` | Period summaries for a company | `{ companyId }` | admin (scoped) | read-only |
| `getSavedPayments` | Saved payments for the editable draft table | `{ periodId, companyId }` | admin (scoped) | read-only |
| `lockPeriod` | Lock a pay period (blocks on null/negative net or pending approved hours) | `LockPeriodSchema` | admin (scoped) | update `pay_periods`; audit `lock` |
| `unlockPeriod` | Unlock a locked (not yet paid) period | `UnlockPeriodSchema` | admin (scoped) | update `pay_periods`; audit `unlock_period` |
| `updatePaymentRowAction` | Update editable fields on an open period's payment row (recomputes net) | `UpdatePaymentRowSchema` | admin (scoped) | update `payments` |
| `deleteStatement` | Delete a single statement for a contractor | `DeleteStatementSchema` | admin (scoped) | delete statement/`payments`; audit `delete_statement` |
| `deleteAllStatements` | Delete all statements in a period (open only) | `DeleteAllStatementsSchema` | admin (scoped) | delete statements; audit `delete_statement` (`whole_period`) |
| `getProcessPayments` | Payments for the Process screen (locked/paid periods) | `{ periodId, companyId }` | admin (scoped) | read-only |
| `markPaid` | Mark selected payments paid; sync period state | `MarkPaidSchema` | admin (scoped) | update `payments` + `pay_periods`; audit `mark_paid` |
| `markUnpaid` | Mark selected payments unpaid; sync period state | `MarkUnpaidSchema` | admin (scoped) | update `payments` + `pay_periods`; audit `mark_unpaid` |
| `markAllUnpaid` | Mark all non-Wise-transfer payments unpaid; step period back to LOCKED | `MarkAllUnpaidSchema` | admin (scoped) | update `payments` + `pay_periods`; audit `mark_unpaid` (`all`) |
| `toggleWiseRowLock` | Lock / unlock a Wise transfer row (unlock requires a reason) | `ToggleWiseRowLockSchema` | admin (scoped) | update `payments`; audit `wise_lock_release` (on unlock) |

### `reconcile.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `getReconcileOverview` | Reconciliation overview with Wise reconcile status per period | `companyId: string` | admin (scoped) | read-only |
| `reconcileAllPending` | Bulk-finalize confirmed payments to `reconciled` | `companyId: string` | admin (scoped) | update `payments` → `reconciled` + `pay_periods`; audit `wise_recipient_sync` |

---

## Invoicing

Source: `invoicing.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `previewInvoice` | Build an invoice preview (no persistence) for a client window | `PreviewInvoiceSchema` | admin (scoped) | read-only |
| `generateInvoice` | Generate & persist a draft invoice + lines from a server-side recompute | `GenerateInvoiceSchema` | admin (scoped) | insert `invoices` + `invoice_lines`; audit `invoice_generated`; revalidate `/invoicing` |
| `setInvoiceStatus` | Set invoice status (draft → sent → void; paid goes via `markInvoicePaid`) | `SetInvoiceStatusSchema` | admin (RLS-scoped) | update `invoices`; audit `invoice_voided` / `invoice_status`; revalidate `/invoicing` |
| `markInvoicePaid` | Mark an invoice paid and record its A/R receipt | `MarkInvoicePaidSchema` | admin (RLS-scoped) | update `invoices` + insert `ar_receipts`; audit `invoice_paid`; revalidate `/invoicing` |

---

## Wise

Source: `wise.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `wiseDraft` | Create a quote + draft transfer per payment (no funding) | `paymentIds: string[]` | owner | Wise API → update `payments` (`wise_transfer_id`, `fx_rate`); audit `wise_draft` |
| `wiseBatch` | Draft transfers inside a Wise batch group (no funding) | `paymentIds: string[]` | owner | Wise API → update `payments` + batch group; audit `wise_batch` |
| `wisePoll` | Reconcile — flip payments to `sent` on terminal Wise success (idempotent) | — (none) | admin | Wise API → update `payments` (audit inside service) |
| `wiseMatch` | Backfill matcher for payments missing `wise_transfer_id` | `{ periodStart?, periodEnd?, payPeriodId?, windowDays?, refresh? }` | admin | Wise API → update `payments`; audit `wise_match` / `wise_match_override` |
| `wiseStatus` | Transfer-status lookups for payment ids | `WiseStatusSchema` (`paymentIds: string[]`) | admin | Wise API read-only |
| `wiseRecipients` | Recipient list for the profile panel | — (none) | admin | Wise API read-only |
| `wisePullRecipientIds` | Match Wise recipients by name and backfill `wise_recipient_id` | — (none) | admin | Wise API → update `workers`; audit `wise_pull_recipient_ids`; revalidate `/contractors` |
| `wiseGetRecipient` | Single recipient lookup | `WiseGetRecipientSchema` (`recipientId: number`) | admin | Wise API read-only |
| `wiseFindTransfersByRecipient` | Find transfers to a recipient within a date window | `WiseFindTransfersSchema` (`recipientId: number`) | admin | Wise API read-only |

---

## Sessions

Source: `sessions.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `loadClientSessions` | Load a client's active roster + sessions for a date window | `LoadSessionsSchema` (`{ clientId, from, to }`) | admin (scoped) | read-only |
| `createSession` | Record one session/visit (pending) | `CreateSessionSchema` | admin (scoped) | insert `sessions`; audit `session_created` |
| `setSessionApproval` | Approve / reject / reset a set of sessions | `SetSessionApprovalSchema` | admin (scoped) | update `sessions`; audit `approve_session` |
| `importSessions` | Bulk-import sessions from CSV (worker ids pre-resolved) | `ImportSessionsSchema` | admin (scoped) | insert `sessions`; audit `sessions_imported` |
| `deleteSession` | Delete a single session | `DeleteSessionSchema` | admin (scoped) | delete `sessions`; audit `delete_session` |

---

## Coverage

Source: `coverage.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `setCoverageTarget` | Set (replace) a worker's open coverage target for a company | `SetCoverageTargetSchema` (`{ companyId, workerId, targetHours, periodKind }`) | admin (scoped) | replace `coverage_targets`; audit `coverage_target_set`; revalidate `/coverage` |
| `clearCoverageTarget` | Clear a worker's open coverage target (revert to `weekly_hours`) | `ClearCoverageTargetSchema` (`{ companyId, workerId }`) | admin (scoped) | delete `coverage_targets`; audit `coverage_target_cleared`; revalidate `/coverage` |

---

## Reports

Source: `reports.ts`, `reports-detail.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `getReportDetail` | Payment-level rows for the detail CSV export | `DetailExportSchema` (`{ companyId, fromDate, toDate }`) | admin (scoped) | read-only |
| `getReportsData` | KPI strip + payout-by-period + contractor pay summary | `companyId: string` | admin (scoped) | read-only |
| `getContractorHistory` | Per-contractor pay & hours history (worked + PTO merged with statement components) | `companyId, workerId` | admin (scoped) | read-only |
| `getUtilization` | Avg. Hubstaff activity % per contractor per week (approved entries) | `companyId, workerIds[]` | admin (scoped) | read-only |

---

## Documents

Source: `documents.ts`, `documents-admin.ts`.

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `runExpiryCheckNow` | On-demand expiry check (overdue + expiring-soon lists; no email) | `withinDays = 30` | admin | read-only (`skipEmail`) |
| `runHiringReviewCheckNow` | On-demand hiring-review check (pending + deferred lists; no email) | — (none) | admin | read-only (`skipEmail`) |
| `addDocument` | Add a tracked document (agreement, W-8BEN, gov ID, other) for a contractor | `AddDocumentInput` (`{ companyId, workerId, kind, title, signedOn, expiresOn }`) | admin (scoped) | insert `documents`; audit `add_document`; revalidate `/documents` |

---

## Company, config & admins

Source: `company.ts`, `config.ts`, `admin-manage.ts`.

### `company.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `selectCompany` | Switch the admin's working company via cookie | `companyId: string` | admin | set `COMPANY_COOKIE`; revalidate `/` (layout) |

### `config.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `saveEmployer` | Edit the single employer (or create the first one) | `{ id?, name, hubstaffOrgId?, taxId?, address?, phone?, website?, contacts? }` | admin | insert/update `companies`; audit `config.employer_created` / `config.employer_updated`; revalidate `/config` |
| `saveClient` | Create or edit a client company | `{ id?, name, hubstaffOrgId?, taxId?, address?, phone?, website?, contacts? }` | admin | insert/update `companies`; audit `config.client_created` / `config.client_updated`; revalidate `/config` |
| `setClientStatus` | Archive / unarchive a client | `{ id, status: 'active'\|'inactive' }` | admin | update `companies.status`; audit `config.client_status`; revalidate `/config` |
| `deleteClient` | Permanently delete a client (usage check + typed-name confirm) | `{ id, confirmName }` | owner | delete `companies` (cascade); audit `config.client_deleted`; revalidate `/config` |
| `setEditableFields` | Set which profile fields contractors may self-edit | `{ fields: string[] }` | admin | update `portal_settings`; audit `config.editable_fields`; revalidate `/config` |
| `saveAgreementTemplate` | Create / update an agreement template | `{ kind, title, body, version? }` | admin | upsert `agreement_templates`; audit `config.agreement_template`; revalidate `/config` |
| `loadHubstaffProjects` | Load projects from the employer's Hubstaff org and upsert them | — (none) | admin | Hubstaff API → upsert `hubstaff_projects`; audit `config.hubstaff_projects_loaded`; revalidate `/config` |
| `assignHubstaffProject` | Assign a Hubstaff project to a client (or back to the employer) | `{ hubstaffProjectId, companyId }` | admin | update `hubstaff_projects`; audit `config.hubstaff_project_assigned`; revalidate `/config` |
| `saveOnboardingConfig` | Save onboarding config (read-merge-write to preserve unknown keys) | `{ config: unknown }` | admin | update `portal_settings`; audit `config.onboarding_saved`; revalidate `/config` |
| `postAnnouncement` | Create or edit an announcement | `{ id?, title, body? }` | admin | insert/update `announcements`; audit `config.announcement_posted` / `config.announcement_updated`; revalidate `/config` |
| `setAnnouncementActive` | Hide / show an announcement on the portal home | `{ id, active }` | admin | update `announcements`; audit `config.announcement_active`; revalidate `/config` |
| `deleteAnnouncement` | Delete an announcement | `{ id }` | admin | delete `announcements`; audit `config.announcement_deleted`; revalidate `/config` |

### `admin-manage.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `addAdmin` | Add an admin (or stage a pending invite for auto-promotion on first sign-in) | `{ email, name?, role, companyIds[] }` | owner | `admin_lookup_auth_user` RPC; insert `pending_admins` / `admin_users` (+ `admin_companies`); audit `admin.pre_added` / `admin.added` |
| `removeAdmin` | Remove an admin or cancel a pending invite (last owner is DB-protected) | `{ email }` | owner | delete `pending_admins` / `admin_users` (+ `admin_companies`); audit `admin.invite_removed` / `admin.removed` |
| `setAdminCompanies` | Replace a non-owner admin's company scope (applies the diff) | `{ email, companyIds[] }` | owner | insert/delete `admin_companies`; audit `admin.companies_changed` |
| `setAdminRole` | Promote / demote an admin's role; toggle `can_countersign` (last owner is DB-protected) | `{ email, role, canCountersign? }` | owner | update `admin_users`; audit `admin.role_changed` |

---

## Portal — contractor

Source: `portal.ts`, `portal-docs.ts`, `portal-sessions.ts`. These run under the
contractor's own identity (`requireWorker` / `getCurrentWorker`), with a few
**admin** review actions co-located in `portal.ts`.

### `portal.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `updateOwnProfile` | Update own whitelisted profile fields | `{ fields: Record<string, string\|null> }` | worker | update `workers` (service client) |
| `completeOnboardingTab` | Mark a Stage-2 onboarding tab complete | `{ tab }` | worker | update `onboarding_progress` |
| `advanceFromStage1` | Advance from Stage 1 when all required agreements are signed | — (none) | worker | update `onboarding_progress` |
| `finishOnboarding` | Self-complete onboarding once all required docs are approved | — (none) | worker | update `onboarding_progress` |
| `signAgreement` | Sign an agreement (stores encrypted signature) | `{ agreementKey, signatureDataUrl, typedName, scrolledToEnd? }` | worker | upsert `onboarding_signatures` + `onboarding_progress`; audit `agreement.signed` |
| `countersignAgreement` | Admin countersigns an agreement (`can_countersign` required) | `{ workerId, agreementKey, signatureDataUrl }` | admin | upsert `onboarding_agreements`; audit `agreement.countersigned` |
| `reviewDocument` | Review a document (approve / needs_replacement / waive / defer) | `{ documentId, decision, note? }` | admin | update `documents`; recompute stage 3; audit `document.*` (+ `onboarding.completed`) |
| `resolveMissingDocument` | Waive / defer a required-but-missing document (fileless row) | `{ workerId, kind, side?, decision, deferUntil?, note? }` | admin | insert fileless `documents`; recompute stage 3; audit `document.*` (+ `onboarding.completed`) |
| `clearMissingDocumentResolution` | Revert a waive/defer on a missing required doc | `{ workerId, kind, side? }` | admin | delete fileless `documents`; recompute stage 3; audit `document.resolution_cleared` |
| `setSignedDate` | Set the editable signed date on a signature (admin correction) | `{ documentId, signedDate }` | admin | update `onboarding_signatures.signed_date`; audit `signature.signed_date_set` |
| `saveMoodCheckin` | Record the worker's mood check-in | `{ mood, note?, kind? }` | worker | insert mood check-in (RLS user client) |
| `getDocumentSignedUrl` | 120s signed URL for the worker's own document | `{ documentId }` | worker | read-only; storage signed URL |
| `getAdminDocumentUrl` | Signed URL for any contractor's document (company scope checked) | `{ documentId }` | admin (scoped) | read-only; storage signed URL |
| `revealMyTools` | Reveal the worker's provisioned tool credentials | — (none) | worker | `get_my_tools` RPC (decrypt) |
| `ackMyTools` | Acknowledge the tools popup | — (none) | worker | `ack_my_tools` RPC |

### `portal-docs.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `fetchOutstandingDocSlots` | Compute the contractor's required-but-missing document slots | — (none) | worker | read-only |
| `uploadOwnDocument` | Upload a document to storage and create its `documents` row | `FormData` (`file`, `kind`, `side?`, `issuedOn?`) | worker | upload to `contractor-docs` bucket; insert `documents` (review `pending`) |

### `portal-sessions.ts`

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `createContractorSession` | Submit an Early-Intervention session (recorded pending) | `CreateContractorSessionSchema` | worker | insert `sessions` (status `pending`); re-checks onboarding gate + active client link |

---

## Portal — admin

Source: `portal-admin.ts`. Admin-only login/account lifecycle for contractor
portal accounts. (This file also defines the shared `ActionResult` type.)

| Action | Purpose | Input | Auth | Side effects |
|---|---|---|---|---|
| `createPortalLogin` | Create a portal login (temp password + welcome email) | `{ workerId, email }` | admin | `auth.admin.createUser`; insert `contractor_logins`; `seedOnboardingProgress`; welcome email (best-effort); audit `portal_login.created` |
| `resetPortalPassword` | Re-issue a temp password (and optionally correct the email) | `{ workerId, email? }` | admin | `auth.admin.updateUserById`; update `contractor_logins.email`; credentials email (best-effort); audit `portal_login.reset_password` |
| `revokePortalLogin` | Revoke a contractor's portal access | `{ workerId }` | admin | set `contractor_logins.status='revoked'`; audit `portal_login.revoked` |
| `resendHireEmails` | Resend the welcome / credentials emails | `{ workerId, which?, password? }` | admin | send 1–2 emails (best-effort); audit `portal_login.resend_hire_emails` |
| `sendToolsEmail` | Decrypt the worker's tools and email the credentials | `{ workerId }` | admin (scoped) | `decryptWorkerTools` RPC; tools email (best-effort); audit `portal_login.send_tools_email` |
| `withdrawOffer` | Withdraw a pending offer (revoke login, ban auth user, end worker/links, notify) | `{ workerId }` | admin | blocks if payroll history; set `contractor_logins.status`; ban auth user; set `workers`/`worker_companies` status `ended`; withdrawal email (best-effort); audit `withdraw_offer` |
| `deleteContractor` | Full destructive deletion (auth user + all rows) | `{ workerId, force? }` | owner | hard-blocks on payroll history, soft-blocks (needs `force`) on signatures/docs; delete `workers`; delete auth user (best-effort); audit `delete_contractor` |
