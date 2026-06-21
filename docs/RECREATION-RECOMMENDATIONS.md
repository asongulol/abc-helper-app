# Recreation Recommendations — old app → `abc-helper-app`

Feature-by-feature analysis of the legacy spec, with a verdict on each and a phased
build plan. **Goal:** recreate the legacy app's real value without copying the
workarounds it needed as a buildless single-file SPA.

- **Source:** `asongulol/abc-work-app-payroll-wis-hubstaff-app` → `docs/FEATURES.md`
  (commit `2e31baf`, `main`). Section refs below (§) point into that file.
- **Target:** this repo (Next.js App Router · TypeScript strict · @supabase/ssr · server actions · Biome).
- **Sequencing:** this is **post-cutover** work — the README rule is "parity first,
  features later." These recreation phases (R1–R5) run *after* Phase 6 cutover.
- **Scope note:** per direction, **all** suggestions are captured here, including
  low-priority and optional ones. The three previously-open decisions
  (invoicing / tools vault / morale features) are all included, with the risky ones
  recorded as redesigns rather than literal copies.

---

## How to read this

The legacy `FEATURES.md` conflates three different things. Each item below is tagged:

- ❌ **Don't recreate** — an architectural workaround the new stack obviates.
- 🛑 **Fix on the way over** — a real design/data decision that is wrong; port the intent, fix the implementation.
- ✅ **Keep** — genuinely good; already rebuilt in this repo. No action beyond verification.
- 🧩 **Gap** — absent here; build it (priority noted).

---

## ❌ Don't recreate — the new stack already does this better

| Legacy item (§) | Why it existed | Replacement here |
|---|---|---|
| Single-file SPA + Babel-in-browser, no build (§1) | No tooling | Next.js build pipeline — done |
| Kill switch + `legacy.html` + `?ui=classic` (§3.7) | Manual rollback for risky deploys | Vercel atomic deploys + instant rollback |
| `version.txt` poll + `no-store` shell self-update (§3.7) | No asset hashing | Next.js content-hashed assets/caching |
| Lazy-mount-then-keep-hidden (`display:none`) tabs (§4) | No router; preserve in-memory state | App Router routes + server-fetched data |
| Table→card transform via `data-label` CSS hack (§2.2) | One big stylesheet | Tailwind responsive components (port behavior, not hack) |
| `pageAll` — fire all PostgREST pages concurrently (§3.1) | Beat the 1000-row cap client-side | SQL aggregation / server pagination (e.g. `v_payouts_by_period`) |
| Client-side direct DB writes "safe because RLS" (§7.3) | No server tier | Server actions + Zod — already replaced |

---

## 🛑 Bad designs — fix as you port

| # | Problem (§) | Fix |
|---|---|---|
| 1 | `deduction_php` is named "deduction" but is **never subtracted** (it's the perf shortfall; §5.8 flags it twice) | Use the separate `shortfall_php` the new `calc.ts` already emits; never reintroduce the misleading column/label |
| 2 | All edge functions deployed `--no-verify-jwt`, "in-code gate is the control" (§7.1) | Keep edge functions cron-only + secret-gated; verify JWT where possible; payroll mutations stay in server actions (ADR-0004) |
| 3 | `worker_tools` stores contractors' **recoverable** 3rd-party passwords (§5.6/§7.2) | Redesign: one-time secure share (or drop). Do not store recoverable external credentials |
| 4 | Avatars = 256px JPEG **data-URI in a TEXT column** (§3.1) | Store in the Supabase Storage bucket; keep only a URL/path |
| 5 | Hardcoded employer UUID `11111111-…`, "historically mislabeled" (§1) | Derive employer from `companies.kind='employer'`; no magic UUID in code |
| 6 | Two email providers — Resend + Gmail SMTP (§7.1) | Standardize on Gmail SMTP/nodemailer (already done here); don't reintroduce Resend |
| 7 | `app_secrets`, `worker_tools`, `admin_users.name/can_countersign` applied via **raw SQL, not migrations** (§8) | Capture all of it in the baseline migration; no out-of-band DDL |

---

## ✅ Keep — already rebuilt, don't rewrite

Verified present and well-built in this repo:

- Payroll math — arrears `periodFor`, `expectedHours`, ratio cap 5, HA-at-anniversary, half-annual 13th, misc items (§5.8). Parity-tested to the centavo.
- Employer/client model — payroll at employer, clients are billing tags w/ `bill_rate_usd` (§1).
- Onboarding gate + immutable e-sign ledger — sha256, IP/UA, scroll-to-end gate, countersign (§5.6, §6).
- Document review — approve / needs-replacement / waive / defer, NBI freshness (§5.6).
- Wise draft-only + reconciliation/backfill matcher, preserving `original_net_php` (§5.9–5.10).
- Time approval — ID-first→strict→loose matching, pending auto-reveal, overlap detect, `import_batch_id` (§5.7).
- Audit log with before→after diffs (§5.14).
- Typed-confirm modal — `ConfirmDangerModal.tsx` (§3.4); extend coverage (see R4).

---

## 🧩 Gaps — absent here, build them

| Feature (§) | Approach | Priority |
|---|---|---|
| Invoicing / client billing (§5.12) | Port `bill_rate_usd × hours`, markup, `allocate_invoice_no`, void/regenerate, status flow | **High** (confirm prod usage first) |
| PDF / print — agreements, invoices, pay slips (§5.6, §5.12) | Server-rendered printable HTML / PDF; no `printDoc` equivalent today | **High** |
| Data-entry helpers — EmailInput, PhoneInput (PH/US), ContractorPicker (§3.1) | Reimplement idiomatically as React components | Medium |
| Unsaved-changes guard (§3.2) | **Redesign:** scope to big forms (ProfileModal, hire wizard) via `beforeunload` + router intercept — not a global registry | Medium |
| Draft autosave/resume for hire wizard (§3.3) | localStorage only; pairs with the guard | Medium |
| Command palette (⌘K) (§2.2) | Client component over sections/contractors/periods | Low–Med |
| Mood check-in write path (§6) | Currently a no-op that fakes success — wire to `mood_checkins` or remove the UI | Low |
| Portal "Time" + "Docs" tabs (§6) | Dropped in rewrite; add only if contractors need self-service views | Low–Med |
| Turnstile on portal login (§6) | Re-add when site key exists; never client-block (Supabase Auth enforces) | Low |
| Portal "From New York" weather hero (§6) | **Simplify hard** (static greeting + clock) or skip; animated SVG skyline isn't worth the upkeep | Low |

---

## Phased plan (post-cutover)

### R1 — Correctness & safety (cheap, do regardless)
- [x] Retire the misleading `deduction_php` concept; standardize on `shortfall_php` end-to-end (#1)
- [x] Lock down edge-function auth — cron-only + secret-gated, no blanket `--no-verify-jwt` (#2 — explicit `verify_jwt = false` + secret gate in config.toml)
- [x] Capture all out-of-band schema in the baseline migration (#7 — verified: app_secrets, worker_tools, admin_users.name/can_countersign all present)
- [x] Derive the employer from `companies.kind`; remove any hardcoded UUID (#5)
- [x] Confirm email is single-provider (Gmail SMTP) and stays that way (#6 — verified: nodemailer only, no Resend dep/env)

### R2 — Close the stubs
- [x] Mood check-in: real write path (`saveMoodCheckin` → `mood_checkins` via the worker's RLS client); fake-success stub removed
- [x] Avatars → Supabase Storage (#4 — `avatars` bucket + RLS in migration 0002; `photo_url` holds the object path)
- [x] Turnstile on portal login — rendered + token attached when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set; never client-blocks

### R3 — High-value gaps
- [x] Invoicing module — `compute`(+tests)/queries/actions/`/invoicing` page+UI/print route/nav; built in-app (Hubstaff import deferred)
- [x] PDF/print — pay slips (admin + portal routes), signed agreements (XSS-safe `lib/agreements/merge.ts` + `safeSigImg`, admin + portal routes + admin print links), invoice print

### R4 — Admin UX parity
- [x] Typed-confirm — LOCK (PayrollShell), DELETE (owner-only typed-name, ContractorsClient), WITHDRAW (OnboardingDrilldown); RECALCULATE already present
- [x] EmailInput / PhoneInput / ContractorPicker helpers — built + exported; ProfilePanel email/mobile retrofitted
- [x] Unsaved-changes guard — `useUnsavedGuard` hook built **and wired** into `ProfilePanel.tsx` and `PortalFieldsCard.tsx`; the hire wizard additionally keeps its localStorage draft autosave
- [x] Draft autosave/resume — `hire-draft` (`eis_hire_draft_<companyId>`) + resume banner in the 3-step `AddContractorWizard`
- [x] Command palette (⌘K) — mounted in AdminShell (⌘K + Find); layout feeds roster + periods; routes with `?focus=`/`?period=`

### R5 — Portal polish / morale (optional)
- [x] Portal "Time" + "Docs" tabs — own `time_entries` (onboarding-gated) + own `documents` (120s signed-URL view + re-upload); nav added
- [N/A] Simplified portal home hero — the rewrite's portal home is already minimal (no animated weather/skyline to remove)
- [x] `worker_tools` one-time reveal (#3) + portal `ToolsPopup` (`get_my_tools`/`ack_my_tools`, gated by `my_tools_pending()` migration 0006)

### Correctness improvements (additive migrations, this session)
- [x] `0004` — atomic/unique `invoice_no` (partial UNIQUE + advisory-lock/`max()` allocator)
- [x] `0005` — `audit_log` append-only trigger (BEFORE UPDATE/DELETE/TRUNCATE)
- [x] `0006` — `my_tools_pending()` (non-destructive portal gate)

> **Build status:** typecheck 0 · biome clean · 296 tests · guardrails clean · `pnpm build` OK. Migrations `0004–0006` reference verified-present prod objects; full apply-validation runs at the cutover dry-run (`supabase db reset`).

---

## Open items to confirm

- ~~**Invoicing usage**~~ — RESOLVED: built in-app per direction (Hubstaff import deferred).
- ~~**Portal self-service**~~ — RESOLVED: Time + Docs tabs added.
- ~~**Tools vault**~~ — RESOLVED: one-time reveal (decrypt-then-purge) + portal `ToolsPopup`.
- **Follow-ups:** surface the contractor agreement-print link inside the portal onboarding flow; run `supabase db reset` (or a branch) to apply-validate the migrations before cutover.
