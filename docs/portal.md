---
title: Contractor portal
sidebar_position: 9
---

# Contractor portal

The self-serve surface for contractors — onboarding, profile, time, sessions, payslips, and
documents — served from the same Next.js app as the admin console (see
[Architecture](./architecture.md)) under `/portal`.

## Surface

Authenticated routes live under `src/app/portal/(authed)/`:

| Route | Shows |
|---|---|
| `/portal` (home) | Pay-period progress, last/next payment, activity chart, announcements, pending-docs reminder, tools status |
| `/portal/profile` | Self-edit profile (fields gated by config — see below) |
| `/portal/time` | Time-entry history *(requires onboarding complete)* |
| `/portal/sessions` | Submit Early-Intervention sessions *(requires onboarding complete)* |
| `/portal/statements` | Payslip / payment history (+ printable statement) |
| `/portal/docs` | Upload & track required documents |
| `/portal/onboarding` | The 3-stage wizard ([Onboarding & documents](./onboarding-documents.md)) |

`PortalShell` (`src/components/portal/PortalShell.tsx`) is the nav/header wrapper, with onboarding
and pending-docs badges. The home dashboard (`PortalDashboard`) composes `PortalPayActivity`,
the `FromNewYork` hero, the docs-reminder overlay, and the tools popup.

## Authentication & gating

- **Login** (`/portal/login`): email + password via `supabase.auth.signInWithPassword()`
  (optional Cloudflare Turnstile), with self-serve password reset. No SSO domain gate (contractors
  use personal emails). The form is `src/components/auth/PortalLoginForm.tsx` (under `auth/`, not
  `portal/`).
- **Session**: `getCurrentWorker()` (`src/server/auth/worker.ts`) resolves the Supabase user →
  `contractor_logins` (where `status = 'active'`) → `workers`, and calls `is_onboarded()`. The
  `(authed)` layout redirects to `/portal/login` if there's no worker.
- **Onboarding gate**: Time and Sessions check `worker.onboarded`; until onboarding is complete
  they show a "will appear once onboarding is complete" notice.
- **RLS scope**: contractor reads use the RLS user client filtered by `my_worker_id()` — a
  contractor sees only their own rows. `contractor_logins.status = 'active'` mirrors
  `my_worker_id()` exactly, so a revoked login resolves to nothing.

## Profile self-service

What a contractor may edit is the **intersection** of two allow-lists:

1. **`SAFE_FIELDS`** — a hardcoded set in `src/server/actions/portal.ts` (~25 fields: names, work
   + personal contact, payout methods like `gcash`/`paymaya`/`paypal`/`wise_tag`, emergency
   contact, demographics, and JSONB "extras" like `nickname`/`hobbies`/`motto`).
2. **`portal_settings.editable_fields`** — the admin-controlled subset, read by
   `fetchPortalSettings()` (`src/db/queries/portal.ts`).

`updateOwnProfile()` validates input against that intersection, splits real columns from
`profile_extras` (merging extras without clobbering), and writes via the service client (since RLS
has no contractor write policy — the field whitelist *is* the gate). Without a `portal_settings`
row, `editable_fields` defaults to empty and the whole profile is read-only.

## Data each tab reads

Via `src/db/queries/portal.ts`, all RLS-scoped to the worker:

`fetchOwnProfile`, `fetchOwnPayments`, `fetchOwnDocuments`, `fetchOwnTimeEntries` (also gated by
`is_onboarded()`), `fetchOwnOnboarding` (progress + signatures + agreements), `fetchOwnNotifications`
/ `dismissNotification`, `fetchAnnouncements`, `fetchLatestMoodCheckin` / `insertMoodCheckin`, and
`fetchPortalSettings`.

> The **Sessions** tab is the exception: its reads (`fetchWorkerClients` / `fetchWorkerSessions` in
> `src/db/queries/sessions.ts`) go through a worker-filtered **service** client, because
> `worker_companies` / `companies` are admin-only under RLS.

## Contractor actions

`src/server/actions/portal*.ts` (each re-checks `requireWorker()` and ownership):

- **Onboarding**: `signAgreement()` (signs the 4 agreements in order; PHI signature encrypted),
  `completeOnboardingTab()`, `advanceFromStage1()`, `finishOnboarding()`.
- **Documents** (`portal-docs.ts`): `fetchOutstandingDocSlots()`, `uploadOwnDocument()` (→
  `contractor-docs` bucket), `getDocumentSignedUrl()` (120s signed URL, ownership re-checked).
- **Sessions** (`portal-sessions.ts`): `createContractorSession()` — gated on being onboarded and
  actively assigned to the client; lands `pending` for admin approval.
- **Misc**: `saveMoodCheckin()`, `revealMyTools()` / `ackMyTools()` (provisioned tool credentials,
  read via the `get_my_tools` RPC).

## Admin management of portal logins

`src/server/actions/portal-admin.ts` (admin-gated):

- `createPortalLogin()` — creates the Supabase auth user, a temp password, the `contractor_logins`
  link (`status = 'active'`), seeds `onboarding_progress`, and emails a welcome (best-effort).
- `resetPortalPassword()` — new temp password via `auth.admin.updateUserById()`, optionally
  correcting the email in both auth and `contractor_logins`.
- `revokePortalLogin()` — sets `contractor_logins.status = 'revoked'` (login stops working
  immediately via the `getCurrentWorker` gate).
- Plus document review/countersign (see [Onboarding & documents](./onboarding-documents.md)),
  `resendHireEmails()`, `sendToolsEmail()`, `withdrawOffer()`, and the owner-gated, guarded
  `deleteContractor()` (refuses if pay/time history exists).

For seeding a working portal login locally, see [Local development](./local-development.md).
