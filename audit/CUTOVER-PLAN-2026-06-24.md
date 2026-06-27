# Cutover plan — abc-helper-app → production (2026-06-24)

Adversarial cutover plan produced against the live codebase + the two legacy
sibling repos. Supersedes nothing; **reconciles and corrects** the older
`docs/CUTOVER-RUNBOOK.md` / `docs/CUTOVER-VERIFICATION.md` / `docs/DEPLOY.md`,
which were written before the "shared-prod, never-overwrite" facts were fully
established (see §0.2 Corrections).

Go/No-Go owner: **Oliver Trinidad** · Host (canonical): **`3a.abbilabs.com`**
Digests: **single-owned at flip** (no parallel-run duplicates) ·
Decommission-legacy trigger: **after 2 clean full pay periods on the new app**

---

## 0. The actual situation (read this first — it changes everything)

### 0.1 This is NOT a database or data migration

The CONTEXT template assumes a stack change with a data migration (engine swap,
ID re-scheme, backfill, reconciliation). **None of that applies here.** Grounded
facts:

| Axis | Source (legacy) | Target (abc-helper) | Changing? |
|---|---|---|---|
| Database | Supabase Postgres `cgsidolrauzsowqlllsz` | **same project, same rows** | **No** |
| Auth | Supabase Auth (GoTrue) | **same** | **No** |
| File storage | Supabase Storage buckets | **same** | **No** |
| Row IDs | UUIDs | **same rows, same UUIDs** | **No** |
| Integrations | Wise, Hubstaff, Gmail SMTP | **same credentials/endpoints** | **No** |
| Money column | `payments.deduction_php` (PHP = Philippine **peso**, not the language) | conformed to `deduction_php` (PR #13, merged) | No (conformed) |
| **App runtime** | monolithic hand-edited `index.html` SPAs (React 18 via CDN+Babel) on **Cloudflare Workers** | **Next.js 16 / React 19 on Vercel** | **YES** |
| **Hosting / origin** | `payroll.abbilabs.com` (admin), `portal.abbilabs.com` (portal) | one origin `3a.abbilabs.com` (admin `/`, portal `/portal`) | **YES** |
| **Background jobs** | legacy edge functions + manually-set prod crons | new Next cron routes + (intended) new crons | **YES — and this is the danger zone** |

**Therefore the cutover is an application-origin swap on a shared DB.** Rollback
is a DNS flip (no data to migrate back). The risk is not "did the data carry
over" — it's "do two apps now fight over one database, one set of crons, and one
set of edge functions."

### 0.2 The legacy apps stay LIVE on the same DB → this is a parallel-run, by construction

`abc-helper-app` is a recreation that **points at the shared production DB owned
by the still-live originals** (`abc-work-app-payroll-wis-hubstaff-app` +
`-admin-redesign` + `-mobile`). Until those are decommissioned, both old and new
read/write the same rows. The architecture decision (user, 2026-06-22) is:
**conform to prod, never mutate prod out from under the live apps.**

### 0.3 Corrections to the existing repo cutover docs (now unsafe as written)

These three statements in the repo are **wrong/dangerous** in light of the
shared-prod reality and are corrected in this plan:

1. **`docs/CUTOVER-VERIFICATION.md` step 5: "schedule the new app's Hubstaff cron
   … the new edge function."** ❌ The new app must **NOT** deploy its vendored
   `hubstaff-sync` / `wise-payouts` edge functions to prod — doing so overwrites
   the legacy **v10** functions the live apps depend on (this exact mistake was
   made and reverted on 2026-06-22). During parallel-run, the **legacy** edge
   functions remain the single owner. The vendored copies in
   `supabase/functions/` are **local-dev only**. → §4, R2.
2. **`docs/CUTOVER-RUNBOOK.md` step 2: "Apply any new migrations to prod —
   additive only. Today there are NONE."** ❌ Two things: (a) abc-helper's
   migrations (0003, 0014, 0015, 0016, 0018, …) are **local-only** and have
   **zero overlap** with prod's migration history — `supabase db push` / CLI
   migration would try to re-run the whole baseline on the live DB. Schema
   changes to prod go **only** via Dashboard SQL Editor, additive, sibling-grep
   verified, guarded by `scripts/assert-local-supabase-target.mjs`. (b) It is not
   true that there were none — the conformance work applied additive objects
   manually (coverage_targets, invoices AR cols, worker_tools.revealed_at,
   `my_tools_pending`). → §2, R3.
3. **`docs/DEPLOY.md`: `ADMIN_SSO_ALLOWED_DOMAIN` defaults to `abckidsny.com`.**
   ⚠️ Code (`src/server/env.ts`) actually defaults to `abckidsny.com,abbilabs.com`.
   The admins sign in on `abbilabs.com`; confirm the prod value includes every
   domain real admins use or they cannot sign in. → §3, R5.

---

## 1. Feature & behavior parity

### 1.1 Status

The recreation is **complete and runtime-verified** (Playwright, 25/25 priority
checks, 2026-06-15) against the prod build with real logins. The money engine is
parity-gated in CI (117 real rows offline + a live read-only gate). So parity
risk is **low and already evidenced** — the work here is to confirm the
*month-end / year-end* surfaces nobody exercises day-to-day, and to lock down the
behavioral traps that come specifically from the JS→TS/runtime change.

### 1.2 Parity matrix (feature → status → owner → verification)

| Feature / surface | Status | Verification | Owner |
|---|---|---|---|
| Payroll calculate → lock → mark-paid | Ported | `pnpm parity:verify` (read-only, prod) exits 0; dry-run cycle reproduced ₱22,727.27 etc. to the centavo | Eng |
| Money formula (gross/ratio/deduction/net, HA, 13th) | Ported, parity-gated | `tests/lib/pay/parity.test.ts` (117 rows) + `batch-parity.test.ts`; §1.3 traps | Eng |
| **13th-month batch (year-end)** ⚠️ rarely run | Ported (opt-in, default off) | Manually replay a Nov-2025-style 13th batch in a scratch period; compare to the 18 "known special periods" the gate excludes | Eng + Owner |
| **Health Allowance (6-mo anniversary)** ⚠️ fires rarely | Ported | Find a worker whose 6-mo anniversary lands in the next period; confirm HA row built | Eng |
| **Reports 5-block (month-end export)** ⚠️ | Ported | Open Reports, export, diff a column total vs legacy for the last closed month | Owner |
| FX rate lock on payments | Ported | Confirm `fx_rate`/`usd_ref` populated on a new draft; USD is reference-only (paid in PHP) | Eng |
| Invoicing + AR (mark-paid, amount/received-on/ref) | Ported (new cols additive, applied to prod) | §2 object-presence SQL; mark an invoice paid end-to-end | Eng |
| Contractor portal (profile, pay-slips ₱, time, docs upload, onboarding e-sign) | Ported, Playwright-verified | Sign in as a contractor on `3a.*`, walk pay-slip + profile + doc upload | Owner |
| Onboarding doc review / countersign | Ported (admin) | Review one onboarding doc; confirm signature capture | Owner |
| Hubstaff time ingest | Ported (but see §4 single-owner) | One manual "Sync now" against employer window; then schedule exactly one cron | Eng |
| Wise draft + reconcile (DRAFT-ONLY) | Ported, guardrail-enforced | Draft a transfer (owner); `wisePoll` reconciles; **never funds** | Owner |
| Doc-expiry digest email | Ported (new Next route) | §4 — single owner; POST `/api/cron/doc-expiry` with secret in staging | Eng |
| Hiring-review digest email (config-driven cadence) | Ported (new Next route) | §4 — honors `reminders` config | Eng |
| Coverage-gap targets + UI | **Added** (not in legacy) | Local-only feature; reads additive prod `coverage_targets` (applied) | Eng |
| **`onboarding_reminders` per-worker ledger** | **Dropped (by decision)** — dead table, no config backs it | Confirmed signed off (audit 2026-06-20) | Owner ✓ |
| `mood_checkins` widget | **Dropped (by decision)** — invented, stripped | Confirmed | Owner ✓ |
| ProfilePanel/Onboarding modal → deep-link route (Phase B/C) | **Deferred** — non-user-facing refactor | Not a cutover blocker | Eng |
| PHI payout-column encryption | **Deferred (by decision)** — payout_account dead; e-wallet handles low-sensitivity; signature_data IS encrypted | Confirmed (2026-06-21) | Owner ✓ |

### 1.3 Behavioral-equivalence traps (JS-in-browser → TypeScript/Node) — verify each

| Trap | Legacy behavior | New stack risk | Concrete check |
|---|---|---|---|
| **Money rounding** | `.toFixed(2)` at each step, then sum (matches the Excel workbook) | A single `.toFixed` at the end, or float drift, diverges by centavos on shared rows | `pnpm parity:verify` replays the exact step order; 35/35 checkable rows match to the centavo. Keep the per-step rounding. |
| **Ratio cap** | `Math.min(worked/exp, 5)` (5× cap) | Dropping the cap overpays a high-hours worker | Covered by parity oracle; spot-check one worker with worked > expected |
| **Deduction semantics** | `deduction_php = rate − gross`; **informational, NOT subtracted from net** | Subtracting it would underpay everyone | Parity oracle asserts net = gross+HA+13th+pdd+bonus+misc; deduction excluded |
| **PHS unset basis** | per-unit; null basis must NOT pay worked×rate | A PHS row with null `pay_basis` silently drops to `unset` → gross/net null (safe), but a wrong default would mis-pay | `payModelFor` returns `unset` → null + `payBasisUnset` flag; zod superRefine + inline guards on all 4 write paths (incl. `saveWorkerCompanyLink`) |
| **Timezone** | Hubstaff `work_date` stored as Manila-local `a.date` verbatim; cron passes Manila-local `today` | Re-deriving dates in UTC would shift the ingest window | Confirmed not a bug (F12 settled); keep passing Manila-local `today` |
| **Currency display** | admin `money()` = `"PHP "`, portal = `₱` | Mixing them is cosmetic but visible | `peso()` vs `money()` split verified vs legacy |
| **NULL / empty** | nullable cols (`rate_php` null ⇒ gross null) | Coercing null→0 would pay ₱0 instead of "needs a rate" | parity oracle includes null-rate rows |

### 1.4 Where did the old stack's logic move to?

Legacy logic lived inline in `index.html` + Postgres `SECURITY DEFINER` helpers
(`is_admin`, `is_company_admin`, `my_worker_id`, `admin_can_see_worker`). In the
new app: the **money math** moved to `src/lib/pay/*` + `src/lib/payroll/*` (pure,
unit-tested); **authorization** is still the **same Postgres RLS + helper
functions on the shared DB** (NOT re-implemented) — see §3.3, this is load-bearing.

---

## 2. Data migration & reconciliation

**Largely N/A — there is no data migration.** Same project, same rows, same IDs.
Stated explicitly because assuming otherwise would invent work and risk. What
*does* need reconciling is **schema-shape compatibility on the shared DB**, in
both directions:

### 2.1 Does prod have every object the new app READS? (else the app 400s)

Run read-only against prod before flip:

```sql
-- additive objects abc-helper depends on (must all be present on prod)
select to_regclass('public.coverage_targets')              is not null as coverage_targets,
       (select count(*) from information_schema.columns
          where table_name='invoices'
            and column_name in ('amount_received_usd','received_on','payment_ref')) as invoice_ar_cols, -- expect 3
       (select count(*) from information_schema.columns
          where table_name='worker_tools' and column_name='revealed_at')           as revealed_at,      -- expect 1
       to_regprocedure('public.my_tools_pending()')         is not null as fn_my_tools_pending,
       to_regprocedure('public.decrypt_worker_tools(uuid)') is not null as fn_decrypt_worker_tools;

-- money column conformance: prod must have deduction_php and NOT shortfall_php
select count(*) filter (where column_name='deduction_php') as has_deduction,  -- expect 1
       count(*) filter (where column_name='shortfall_php') as has_shortfall   -- expect 0
from information_schema.columns where table_name='payments';
```

Memory records these were applied + verified on prod 2026-06-23; **re-verify at
cutover** — do not trust a 3-day-old assertion.

### 2.2 Does prod ACCIDENTALLY carry abc-helper-only constraints that would block the LEGACY apps? (reverse direction — easy to miss)

abc-helper's integrity migrations (**0014** money/ratio CHECKs, **0018**
`payments_period_open_enforce` trigger) are **local-only and must never be on
prod** — they'd constrain the legacy apps' writes (the 0018 trigger apply on
2026-06-22 broke all prod `payments` UPDATEs for a window before being reverted).
Confirm they are **absent** from prod:

```sql
-- expect 0 rows for each — these are abc-helper-only and must NOT be live on shared prod
select conname from pg_constraint
  where conname in ('payments_amounts_nonneg','payments_misc_items_valid',
                    'rates_amount_nonneg','worker_companies_rates_nonneg');
select tgname from pg_trigger where tgname = 'payments_period_open_enforce';
```

If any appear, a prior push leaked them onto the shared DB → investigate before
flip (they may already be silently rejecting legacy writes).

### 2.3 Reconciliation = the money parity gate, not row counts

Row-count/checksum reconciliation is meaningless (one shared table). The
equivalent assurance is the **read-only formula replay**:

```sh
pnpm parity:verify --url https://cgsidolrauzsowqlllsz.supabase.co --key <PROD_SERVICE_KEY>
# pass threshold: exit 0; every "checkable" paid row reproduces stored gross to the centavo.
# Last prod run (2026-06-13): 35/35 checkable matched; 290 manual-override / 52 wise-override /
# 672 no-stored-expected-hours / 18 known-special are EXPECTED exclusions, not failures.
```

### 2.4 PHI/PII

Same store, no new copy → no encryption-at-rest parity gap introduced. Standing
items (not cutover blockers): `signature_data` is envelope-encrypted; payout
columns left plaintext by decision; ensure **no PHI in Vercel logs** — the Next
cron routes and server actions log counts/ids, not document contents or bank
details; spot-check Vercel function logs post-cutover (R10).

---

## 3. Auth, sessions, authorization

### 3.1 Provider — unchanged, but the origin changes

Same Supabase Auth, same users, same password hashes, same MFA. **No forced
re-enrollment, no token reissue.** BUT cookies are per-origin: users currently
signed in on `payroll.*` / `portal.*` will **re-login once** on `3a.abbilabs.com`
(new subdomain = fresh cookie). This is a normal re-login, **not** a mass-logout
incident — but brief the owner so it isn't mistaken for breakage (R5).

### 3.2 The one config that makes or breaks sign-in

Canonical host (Oliver, 2026-06-24): **`3a.abbilabs.com`** — the handoff's
`3a.app.abbilabs.com` was wrong; do not use it. Use the canonical host **verbatim
and identically** in all three places:

1. Vercel custom domain `3a.abbilabs.com` (CNAME → Vercel).
2. Supabase prod Auth → Redirect URLs: add `https://3a.abbilabs.com/auth/callback`.
3. Vercel env `APP_URL = https://3a.abbilabs.com` (bare origin, no path —
   `portalUrl()` appends `/portal`).

Miss #2 → Google OAuth + contractor magic-link both fail (they round-trip
`/auth/callback`). Miss #3 → hire-email portal links point at localhost.

### 3.3 Authorization is the SHARED DB's RLS — verify against PROD, not the repo

**Critical adversarial point.** abc-helper does not re-implement authz; it relies
on the **Postgres RLS policies + helper functions that live on the shared prod
DB** (legacy-defined). The repo's RLS *fixes* (e.g. migration **0014**, which
re-scoped the `pay_periods` cross-tenant leak via
`worker_has_payment_in_period()`) are **local-only and are NOT on prod.** So:

- The historical `pay_periods_contractor_read` leak (any onboarded contractor
  reads every company's pay-period schedule) is fixed **in the repo**, but on
  prod the policy is whatever the legacy apps ship. **Verify the live policy:**

```sql
select polname, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'public.pay_periods'::regclass;
-- adversarial expectation: the USING clause must be worker/company-scoped,
-- not merely is_onboarded(). If it's is_onboarded()-only on prod, the leak is LIVE
-- for both apps and is a prod-DB issue to raise separately — abc-helper inherits it.
```

- **Service-role server actions bypass RLS and must self-enforce company scope.**
  Two (`saveWorkerCompanyLink`, `assignWorkerCompany`) were found missing this and
  fixed (commit bfb9c5f). Re-grep before flip — any `createServiceClient()` path
  that writes worker/company data must gate on
  `admin.isOwner || admin.companyIds.includes(companyId)`:

```sh
rg -n "createServiceClient\(" src/server/actions | rg -v "isOwner|companyIds" # eyeball each hit
```

### 3.4 Multi-tenant isolation — adversarial check (run before flip)

Sign in as a contractor of company A; attempt to read/write a company-B
pay-period, worker, payment, and document. All must be denied by RLS. Because two
apps now share the DB, also confirm a legacy contractor session can't reach
abc-helper-written rows it shouldn't (same policies apply — they will, since
abc-helper writes conformant rows, but verify once).

---

## 4. Integrations & external surfaces — **the real danger zone**

Two apps, one DB, one set of crons, one set of edge functions. Every scheduled or
external surface needs **exactly one owner** during parallel-run.

### 4.1 Background-job ownership matrix

| Job | Legacy owner | abc-helper form | Double-run harm | Cutover rule |
|---|---|---|---|---|
| **Hubstaff ingest** | edge fn `hubstaff-sync` (v10), prod pg_cron ~04:00 Manila | vendored edge fn (local only) + repo cron mig 0010 | **HIGH — refresh token is single-use.** Two syncers rotate the token against each other → ingest breaks for both | **Single syncer.** Disable old cron *before* the new one exists. Do **not** deploy abc-helper's edge fn (R2). Easiest safe path: **keep the legacy edge fn + its prod cron as the one owner** during parallel-run; the new app's "Sync now" button is fine (manual, same token, serialized by a human) |
| **Wise reconcile** | edge fn `wise-payouts`, prod cron every 6h | vendored edge fn (local) + repo cron mig 0016 | Low — status flip is idempotent (sent→sent no-op); only noisy logs | Keep **one** 6h cron (legacy). Don't deploy abc-helper's edge fn. **Never funds** either way (guardrail-enforced) |
| **Doc-expiry digest** | edge fn `documents-expiry-check` | **new Next route** `/api/cron/doc-expiry` | Low — duplicate email | **Single-own at flip** (Oliver, 2026-06-24): in one window, remove the legacy `documents-expiry-check` prod cron AND schedule the new Next digest cron — never both live |
| **Hiring-review digest** | edge fn `hiring-docs-review-check` | **new Next route** `/api/cron/hiring-review` | Low — duplicate email | Single-own at flip, same swap as above |

**How the digest single-own is done at flip (decision: Oliver, 2026-06-24).**
abc-helper's cron schedules live in migrations 0010/0016 which are **never pushed
to prod**, so activating a new digest cron is a *manual, surgical* Dashboard SQL
step — and the legacy one must come down in the same window. Sequence:

1. Set `app_secrets.app_base_url = 'https://3a.abbilabs.com'` (off its `CHANGE-ME`
   placeholder) and confirm `app_secrets.cron_secret == CRON_SECRET` env (R6/R7).
2. **Remove** the legacy prod `pg_cron` jobs that invoke `documents-expiry-check`
   and `hiring-docs-review-check`:
   ```sql
   select jobid, jobname, schedule, command from cron.job
     where command ilike '%documents-expiry-check%'
        or command ilike '%hiring-docs-review-check%';
   select cron.unschedule(jobid) from cron.job
     where command ilike '%documents-expiry-check%'
        or command ilike '%hiring-docs-review-check%';
   ```
3. **Schedule** the two new digests by running **only** the two digest
   `cron.schedule(...)` statements extracted from migration 0016
   (`documents-expiry-digest` 21:00 UTC, `hiring-review-digest` 21:15 UTC) in the
   prod Dashboard SQL Editor. ⚠️ Do **not** run migration 0016 wholesale — it also
   (re)schedules `wise-payouts-reconcile`, which would duplicate the legacy Wise
   cron. Touch only the two digest jobs.
4. Verify: `select jobname, schedule, active from cron.job` shows exactly the two
   new digest jobs (POSTing `3a.abbilabs.com/api/cron/*`) and the legacy digest
   jobs gone. Confirm the next tick actually emails (logs, not just `200`).

### 4.2 Edge functions — hard rule

**Never `supabase functions deploy <any> --project-ref cgsidolrauzsowqlllsz` from
abc-helper.** The shared prod hosts the legacy functions (`hubstaff-sync` v10,
`wise-payouts`, `admin-manage`, `portal-sign/-countersign/-review/-self/-admin`,
`documents-expiry-check`, `hiring-docs-review-check`). abc-helper's
`supabase/functions/` are vendored for local dev only. (This rule exists because
the rule was broken once and clobbered v10.)

### 4.3 Webhooks / inbound

No inbound webhooks found (Wise is **polled**, not pushed; Hubstaff is pulled).
So no double-processing-of-a-webhook risk — the double-run risk is entirely on the
**poll** side, handled by §4.1 single-owner.

### 4.4 Outbound email

Same Gmail SMTP sender. Confirm `GMAIL_USER`/`GMAIL_APP_PASSWORD` set in Vercel
or all hire/onboarding/digest email silently no-ops (best-effort, never throws —
so failures are invisible; check logs for `email not configured`).

### 4.5 DNS / URLs / deep links

- New origin `3a.abbilabs.com` (CNAME → Vercel), **additive** — old subdomains
  keep serving the legacy app as the rollback.
- **Already-sent emails** contain legacy `portal.abbilabs.com` links. Those keep
  working (legacy app stays up). New emails use `APP_URL`. No 404 risk **as long
  as the legacy app stays deployed** — which the rollback plan requires anyway.
  → do not retire `portal.*` until sent-email links have aged out / users migrated.

---

## 5. Cutover mechanics

**Strategy: phased parallel-run with a URL flip, between pay periods.**
Justified by: zero data migration (rollback = DNS), legacy must stay live on the
shared DB anyway, single-owner job constraint. Downtime ≈ the freeze window
(minutes).

### Vercel & DNS state (verified 2026-06-24 via the Vercel CLI — a NEW project is needed)

The host needs a **new, dedicated Vercel project** (decision: Oliver, 2026-06-24).
None of the existing projects in the scope serve it:

| Existing project | Root | Serves | Note |
|---|---|---|---|
| `abc-helper-app` | `website/` | `abc-helper-app.vercel.app` | the **docs site**, NOT the app — do not repoint |
| `npm-helper-app` | `.` | `app.nightingalepm.com` | a separate deploy; **not** the cutover target |
| `npm-helper-docs` | — | `docs.nightingalepm.com` | separate docs deploy |
| `build` | `.` | — | scratch, no prod URL |

Gaps confirmed today:
- `3a.abbilabs.com` is **NXDOMAIN** and is **not** a domain in the Vercel scope.
  `abbilabs.com` is **not** managed in this Vercel account (only `nightingalepm.com`
  is) → its DNS lives wherever `abbilabs.com` is hosted (Cloudflare, where the
  legacy apps run).
- No existing Vercel project builds the app at repo-root for this host.

Wiring sequence (pre-flight) — status 2026-06-24:
1. ✅ **Vercel project created:** `abc-helper-3a` (`prj_wTQzfduxHQZ0HDTE3uFaNQPVrhzm`,
   scope `oliver-trinidad-s-projects`), **Root Directory `.`**. ✅ `3a.abbilabs.com`
   attached as a custom domain (pending DNS). Separate from the `abc-helper-app`
   docs-site project.
2. ⏳ **Set Framework Preset → Next.js.** The bare project defaults to "Other"; the
   repo-root `vercel.json` already pins `framework: nextjs` + `sin1` + headers, so a
   git deploy from Root `.` honors it — but set the preset too to be safe.
3. ⏳ **Connect Git** `asongulol/abc-helper-app` → `abc-helper-3a`, Root `.` (dashboard
   → Settings → Git). Do this only when ready — it triggers a prod build that
   fail-fast-fails until the env (next step) is set, so connect *after* env.
4. ⏳ **Set the full prod env** (below) on `abc-helper-3a` — values are not in the repo.
5. ⏳ **Add the Cloudflare CNAME** for `3a.abbilabs.com` (record below), **DNS-only**.
6. ⏳ Verify it resolves + serves the app shell before announcing.

**Exact Cloudflare DNS record (abbilabs.com zone):**

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `3a` (Cloudflare appends the zone → `3a.abbilabs.com`) |
| Target / Content | `cname.vercel-dns.com` |
| Proxy status | **DNS only** (grey cloud — **NOT** proxied/orange; a proxied record breaks Vercel's TLS issuance) |
| TTL | Auto |

API form: `{"type":"CNAME","name":"3a","content":"cname.vercel-dns.com","ttl":1,"proxied":false}`.
Confirm the target against what the `abc-helper-3a` domain page shows after DNS propagates; the A-record fallback is `76.76.21.21` if an unproxied CNAME isn't possible.

### Pre-flight (any time before)
- [ ] CI green on `main`.
- [ ] **New Vercel app project created** (Root `.`, Next.js, pnpm), separate from the
      `abc-helper-app` docs-site project; `3a.abbilabs.com` added as its custom domain.
- [ ] **DNS:** CNAME `3a.abbilabs.com` → Vercel on the `abbilabs.com` (Cloudflare)
      zone; it resolves (no longer NXDOMAIN).
- [ ] Prod env set **on the new project**: `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`,
      `APP_URL=https://3a.abbilabs.com`, `CRON_SECRET` (== `app_secrets.cron_secret`),
      `GMAIL_USER`/`GMAIL_APP_PASSWORD`, `WISE_API_TOKEN`/`WISE_PROFILE_ID`,
      `HUBSTAFF_REFRESH_TOKEN`, `ADMIN_SSO_ALLOWED_DOMAIN` (incl. every real admin domain).
- [ ] `https://3a.abbilabs.com/auth/callback` added to prod Supabase redirect allowlist.
- [ ] §2.1 object-presence SQL passes; §2.2 reverse-check returns 0 rows.
- [ ] An owner `admin_users` row exists in prod for whoever signs in.
- [ ] App staged at `3a.abbilabs.com`, loads, both admin + a contractor can sign in.

### Flip (pick a window with NO open/locked-unpaid period mid-edit)
1. **Announce + freeze writes on the legacy app** (maintenance/read-only, or
   announce a stop). Confirm no in-flight payroll cycle.
2. **Confirm single job-owner for Hubstaff + Wise:** legacy edge-fn crons remain
   the sole owners (do nothing). Do **not** deploy abc-helper edge functions.
3. **`pnpm parity:verify --url <prod> --key <service_key>` → must exit 0** (read-only).
   ⛔ **POINT OF NO RETURN is *not* here — everything so far is reversible.**
4. **Flip DNS:** point `3a.abbilabs.com` at the Vercel deployment (it's a *new*
   subdomain, so this is additive; legacy subdomains untouched).
5. **Smoke test on prod** (§7.3). Do NOT recalculate a paid period.
6. **Single-own the two digests** (decision: Oliver) — in this same window remove
   the legacy `documents-expiry-check` / `hiring-docs-review-check` prod crons and
   schedule the two new Next digest crons. Exact SQL in §4.1 ("How the digest
   single-own is done at flip"). Hubstaff + Wise crons stay legacy-owned.

**Point of no return:** there isn't a hard one — because no schema/data changes,
every step is reversible by §6. The closest thing is the **first new live payroll
period** processed only on the new app (step below); after money is drafted/paid
from the new app, rolling back means the legacy app must read those new rows
(it can — they're conformant).

### First live period on the new app
Import/approve time → Calculate → review draft table → Lock → draft Wise (OWNER) →
**fund manually in Wise UI** → `wisePoll` reconcile → Mark paid. Gut-check the
period total against what legacy would produce (formula already gated).

### Decommission (ends parallel-run — **after 2 clean full pay periods on the new app**, Oliver 2026-06-24)
Only after **2 clean full pay periods** on the new app: retire legacy subdomains once
sent-email links have aged; stop legacy Cloudflare apps. (The digest crons are
already single-owned by the new app from the flip — §5 step 6 — so nothing digest
-related remains here.) Hubstaff/Wise edge-fn ownership can stay legacy-deployed
indefinitely (they're shared, conformant) or be reassigned deliberately — not
required for cutover.

---

## 6. Rollback & contingency

**Procedure:** flip `<host>` DNS back / re-announce the legacy subdomains.
**Time-to-rollback:** DNS propagation (seconds–minutes; keep TTL low pre-cutover).

**Data written by the new app during parallel-run:** **kept, not discarded.**
Because the schema is conformed (abc-helper writes a subset of prod's shape), the
legacy app reads new-app rows natively (money col `deduction_php`, PHS+`pay_basis`,
etc.). No reconcile/discard needed. The **one** rollback action beyond DNS: if you
had scheduled any *new* digest cron, disable it so it doesn't keep POSTing a
dark app.

**Keep the legacy app fully deployed until ≥1 clean full pay period** on the new
app (it is the rollback *and* the source of already-sent email links).

### Go/No-Go criteria (all must be green)
- §2.1 object-presence SQL all true; §2.2 reverse-check all 0.
- `pnpm parity:verify` exits 0 on prod.
- Sign-in works on `<host>` for admin (Google) + a real contractor.
- §3.4 tenant-isolation probe denied across A/B.
- Exactly one owner per background job confirmed (§4.1); no abc-helper edge fn
  deployed to prod.
- `CRON_SECRET` (env) == `app_secrets.cron_secret` (DB).

### Abort triggers (stop mid-flight)
- parity:verify exits non-zero with an *unexplained* row.
- A §2.2 abc-helper-only constraint/trigger found live on prod.
- Sign-in fails on `<host>` (redirect allowlist / APP_URL).
- Any sign that both Hubstaff syncers are live (token-rotation errors in either
  app's logs).

---

## 7. Observability & support readiness

1. **Logging/metrics live before flip:** Vercel function logs + Supabase logs are
   the new stack's observability (you lose Cloudflare's at flip). Confirm you can
   read Vercel runtime logs and Supabase `get_logs` for the project.
2. **Alerts:** cron routes return 401 on bad secret and `emailed:false` on email
   failure — neither throws. Add a check that the nightly digest actually emailed
   (grep logs) so a misconfigured `CRON_SECRET`/`app_base_url` isn't silent.
3. **Smoke-test suite (run immediately post-flip):**
   - Admin login (Google) → Overview tiles render.
   - Contractor login → portal home + a pay-slip (₱) renders.
   - Core read: open the most recent **paid** period (do not recalc).
   - Core write: edit a contractor profile field → save → re-read.
   - Money path: draft (do not fund) a Wise transfer as owner; confirm draft-only.
   - Tenant isolation: §3.4 cross-company denial.
4. **Support:** brief on the **expected one-time re-login** at the new origin
   (§3.1) and the maintenance window; send the user comms / freeze notice.

---

## 8. Performance & load

Lower-stakes here: same DB (already production-loaded), and the user base is
small (a single employer's contractors). Still:
- **Index review:** abc-helper added worker_id indexes on payments/invoice_lines
  (mig 0015) — but those are local-only; prod's indexes are legacy's. The
  read-heavy screens (Overview, Invoicing, Sessions) paginate (20–25/pg). Confirm
  the prod `payments`/`time_entries` have indexes supporting the period/worker
  filters; if a screen is slow at switch-on it's a missing prod index, not app code.
- **Cold cache:** Vercel `sin1` region (closest to PH). First-load after deploy is
  cold; warm the critical routes before announcing.
- **Known cliff:** none identified; data volumes are modest (≈1k paid rows).

---

## Required deliverables — index
- **Parity matrix** → §1.2 (+ traps §1.3).
- **Data reconciliation spec** → §2 (object-presence SQL §2.1, reverse-check §2.2,
  parity gate §2.3). Pass thresholds inline.
- **Cutover runbook** → §5 (ordered, freeze→verify→flip→smoke; point-of-no-return
  discussed).
- **Rollback plan** → §6 (DNS flip; data kept; one extra action).
- **Go/No-Go checklist** → §6.
- **Risk register** → below.

## Risk register (impact × likelihood, ranked)

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Two Hubstaff syncers** rotate the single-use refresh token against each other → ingest breaks for both apps | High | Med (if new cron/fn deployed) | Single syncer; legacy keeps cron; don't deploy abc-helper edge fn |
| R2 | **Overwriting a shared edge function** (deploy clobbers legacy v10) | High | Med (done once already) | Hard rule §4.2; vendored fns are local-only |
| R3 | **Schema mutation on shared prod** (db push / CLI / stray strict migration blocks legacy writes) | High | Med | Additive-only via Dashboard SQL, sibling-grep; `assert-local-supabase-target.mjs`; §2.2 reverse-check |
| R4 | Money divergence on shared `payments` rows (rounding/cap/deduction) | High | Low | parity:verify (35/35) + 117-row oracle; keep per-step `.toFixed(2)` |
| R5 | Sign-in fails on new origin (redirect allowlist / APP_URL / SSO domain) | High | Med | §3.2 three-places-one-host; confirm `ADMIN_SSO_ALLOWED_DOMAIN` |
| R6 | `CRON_SECRET` env ≠ `app_secrets.cron_secret` → all cron 401 | Med | Med | Pre-flight assert equal |
| R7 | `app_base_url` left `CHANGE-ME` → new digest crons POST nowhere | Med | Med | Don't schedule new digests until set; until then legacy digests own it |
| R8 | **prod RLS ≠ repo RLS** — repo's `pay_periods` leak fix (0014) is local-only; prod may still leak cross-tenant | Med | Med | §3.3 verify live policy on prod; raise as prod-DB issue if present |
| R9 | Service-role server action bypasses RLS without self-scope (cross-tenant write) | High | Low | §3.3 grep; two already fixed (bfb9c5f) |
| R10 | PHI in Vercel logs/error traces | Med | Low | Routes log counts/ids only; spot-check logs post-flip |
| R11 | Duplicate digest emails | Low | Low | Single-owned at flip (§5 step 6): legacy digest cron removed in the same window the new one is scheduled. ⚠️ Don't run mig 0016 wholesale (would dup the Wise cron) |
| R12 | Users think the one-time re-login at new origin = breakage | Low | Med | Brief support (§3.1) |
| R13 | **No Vercel project serves `3a.abbilabs.com`** — the linked `abc-helper-app` project builds the *docs site* (Root `website/`); `npm-helper-app` serves a different host | High | **Confirmed 2026-06-24** | Pre-flight: create a new app project (Root `.`, Next.js, pnpm) + custom domain + env (§5 Vercel & DNS state) |
| R14 | **`3a.abbilabs.com` is NXDOMAIN** — no DNS record; `abbilabs.com` not in the Vercel account | High | **Confirmed 2026-06-24** | Add CNAME → Vercel on the `abbilabs.com` (Cloudflare) zone; verify it resolves before the flip |

---

## Minimum bar to cut over (Go/No-Go owner signs this)

> **We flip only when, against prod (read-only): `pnpm parity:verify` exits 0;
> every additive object the app reads is present (§2.1) and no abc-helper-only
> constraint/trigger is live on prod (§2.2); admin (Google) and a real contractor
> can sign in on `<host>` and tenant A cannot read tenant B; and exactly one owner
> exists for every background job with NO abc-helper edge function deployed to the
> shared project. The legacy app stays fully deployed as the rollback until at
> least one full pay period runs clean on the new app.**

Resolved (Oliver, 2026-06-24): host = **`3a.abbilabs.com`**; Go/No-Go owner =
**Oliver Trinidad**; digests **single-owned at flip** (no parallel-run duplicates);
decommission the legacy apps **after 2 clean full pay periods** on the new app.
No open decisions remain.
