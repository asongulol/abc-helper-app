# Handoff — Faithful design recreation of the legacy payroll app

**Branch:** `feat/faithful-design-recreation` · **Status:** gate-green, not yet merged.

This document hands off the work that recreated the legacy single-file payroll app
(`abc-work-app-payroll-wis-hubstaff-app`) inside this Next.js app (`abc-helper-app`),
to faithful design parity, driven by a screenshot tour of the old app and a follow-up
adversarial fidelity review.

---

## 1. Run it locally

The dev server points at a **local Supabase stack** (`http://127.0.0.1`), never prod.

```bash
# one-time per machine
supabase start                         # local Postgres/Auth/Storage on 127.0.0.1
cd abc-helper-app && pnpm install

# seed local data + logins (idempotent; refuse to run against a non-local URL)
pnpm dev:bootstrap                     # owner admin + demo companies/contractors/rates/time
node scripts/dev-seed-contractor.mjs   # contractor portal login (Maria)

pnpm dev                               # Next.js (currently serving on http://localhost:3100)
```

### Dev logins (local stack only)
| Role | URL | Email | Password |
|---|---|---|---|
| Admin (owner) | `/login` | `owner@abckidsny.com` | `devpassword123` |
| Contractor | `/portal/login` | `maria@abckidsny.com` | `devpassword123` |

Google sign-in is disabled on the local stack — use the email/password form. Override the
seeded creds with `DEV_ADMIN_EMAIL/PASSWORD` and `DEV_CONTRACTOR_EMAIL/PASSWORD`.

### Quality gate (run before merging)
```bash
pnpm typecheck && pnpm exec biome check && pnpm exec vitest run && pnpm guardrails && pnpm build
```
Last run: typecheck ✓ · biome (244 files) ✓ · vitest 296/296 ✓ · guardrails ✓ · build (25/25 routes) ✓.

---

## 2. Source of truth

The legacy app is the authority for every label, field, and layout:
- **Screenshot tour:** `…/abc-work-app-payroll-wis-hubstaff-app/tools/playwright/screenshots/`
  — `admin/*.png` + `*.json` field manifests (authoritative for labels/types/options/buttons),
  `portal/*.png` + `*.json`.
- **Legacy code (for exact behavior/copy/animation):** `…/abc-work-app-payroll-wis-hubstaff-app/app/index.html`
  (admin) and `…/portal/index.html` (contractor portal).

Planning + progress log: `~/.claude/plans/look-at-current-plan-rippling-mango.md`.

---

## 3. What was built (by area)

### Brand
- Real **Aaron Anderson E.H.S. LLC** logo (`public/brand/logo.png`, auto-cropped) via
  `src/components/brand/Logo.tsx` — admin top bar, portal header, both login screens.

### Admin — Configuration (the largest rebuild)
- `src/app/(admin)/config/page.tsx` + `src/components/config/ConfigClient.tsx`: the
  "Configuration" row-list whose rows open modal panels.
- Panels in `src/components/config/`: `EmployerCard`, `ClientsCard`, `ContactsEditor`,
  `HubstaffProjectsCard`, `PortalFieldsCard`, `AgreementTemplatesCard`, `OnboardingConfigCard`,
  `AnnouncementsCard`, `WiseReconCard` (+ kept `AdminsCard`/`HolidaysCard`).
- Foundation: `src/lib/config/fields.ts`, `src/db/queries/config.ts`, `src/server/actions/config.ts`,
  `fetchHubstaffProjects` in `src/server/hubstaff/client.ts`.

### Admin — other
- **Overview** (`src/app/(admin)/overview/`): "what needs your attention" board — THIS PAY
  CYCLE strip, attention status cards, NET PAY + % delta, Data-quality card.
- **Contractors** (`ContractorsClient.tsx`): CLIENT(S) column (`fetchWorkerClientsMap`),
  **Bulk import** (`BulkImportModal.tsx` + `src/server/actions/import.ts`: Wise id→UUID→Hubstaff→name
  matching + "Prefer Wise account name"), **Pull Wise recipients** (`wisePullRecipientIds`).
- **Nav** relabeled to legacy wording + de-duplicated (`src/components/shell/nav.ts`, `AdminShell.tsx`).

### Contractor Profile modal (`src/components/contractors/ProfilePanel.tsx`)
- 4 tabs (Profile · Pay & payout · Personal/HR · Portal & login), UPPERCASE field labels,
  styled **"Unsaved changes"** modal, **photo upload** (avatars bucket; `setWorkerPhoto`/
  `getWorkerPhotoUrl`), **multi-company "Client engagements"** editor (`getWorkerCompanies`/
  `saveWorkerCompanyLink`/`assignWorkerCompany`).
- Data path extended: `RosterWorker` + `SaveWorkerProfileSchema` + `saveWorkerProfile` carry
  HR/shift/payout-tag/bill-rate fields.

### Onboarding (`src/components/onboarding/OnboardingDrilldown.tsx`)
- Agreements ledger table + per-agreement Signed/Countersigned + prefill cards, **"2 · Profile"**
  field dump, Documents review (View/Approve/Needs-replacement/Waive/Defer), stage chips
  (Mark complete / Reset / Reset Stage N), Edit-date / Edit-prefill, Update-login-&-resend,
  owner-only Delete-hire. Backed by `src/server/actions/onboarding.ts`.

### Contractor portal
- **Mobile bottom-tab shell** (desktop sidebar ≥900px) — `src/components/portal/PortalShell.tsx`.
- **"From New York" hero** (`FromNewYork.tsx`): animated time-of-day skyline + lit windows +
  weather FX + dual clocks + Milo (ported from legacy; CSS in `globals.css`).
- **"Your pay"** card + **activity-% chart** with 3-day trend (`PortalPayActivity.tsx`),
  personalized greeting, **Word from Your Mother**, toolkit, **doc-reminder overlay**, Docs badge.
- Profile sub-tabs (`PortalProfile.tsx`) + Pay slips / Time / Docs (`PortalStatements`/`PortalTime`/
  `PortalDocs`) with exact legacy labels/headers.

---

## 4. Data / storage notes
- **No schema migration was needed** beyond the existing baseline. Config + onboarding settings
  live in `portal_settings` (singleton id=1): `editable_fields` + `onboarding_config` JSONB.
  Onboarding saves are **read-merge-write** (preserve `profile_tabs`/unknown keys); reminder
  *settings* live in `onboarding_config.reminders` (NOT the `onboarding_reminders` send-ledger).
- Employer is derived from `companies.kind='employer'` (no magic UUID). Client permanent-delete
  is owner-only + usage-guarded (FK is ON DELETE CASCADE).
- Photos: private `avatars` Storage bucket (migration `…0002`); `workers.photo_url` stores the
  object path; admin uploads client-side (RLS allows admin insert); display via signed URL.
- `time_entries.activity_pct` powers the portal activity chart (added to `fetchOwnTimeEntries`).

---

## 5. Known caveats / deliberate deviations (review before merge)
- **Config panels + new profile features compile/lint/build clean but were not click-tested
  against live data** — do a manual pass (log in as the owner and exercise each modal).
- **WiseReconCard "Check emails"** is intentionally a disabled button — no backing action exists
  in this codebase; wire or remove it per product intent.
- **Bulk import "Prefer Wise account name"** does a per-row Wise lookup for rows with a recipient
  id — fine for small sheets; consider batching for large imports.
- **Mood check-in widget** (portal) has no legacy counterpart — a prior approved deviation.
- **Nav consolidation:** legacy "Calculate" and "Review & Recon Batches" are folded into
  Payroll + a config card; labels were matched but the separate pages were not recreated.
- Nothing is committed to `main`; this is on `feat/faithful-design-recreation`.

---

## 6. Pointers
- Plan + progress: `~/.claude/plans/look-at-current-plan-rippling-mango.md`
- Session memory: `~/.claude/projects/-Users-olivertrinidad-Documents-GitHub-abc-helper-app/memory/design-recreation-status.md`
- Feature-recreation rationale (earlier): `docs/RECREATION-RECOMMENDATIONS.md`
