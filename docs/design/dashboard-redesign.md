# Dashboard redesign — ABC Helper App

Status: **Critical tier + H1–H3 implemented 2026-08-03** · Later tier (L1–L4) and H4–H5 still open.
Scope: `/overview` (admin dashboard), role variants, and minor portal-dashboard additions.
All file references verified against `main` as of this date.

Shipped: C1–C5 (linked tiles, critical band, honest as-of stamp, Needs-Attention queue, role
gating), H1 (per-block Suspense + skeletons + per-block error states), H2 (pipeline "n of m"
semantics + stage links), H3 (sessions/coverage queue rows + audit tail), and H4 (AR tile).
New: `src/lib/overview/attention.ts` (pure ranking, covered by `tests/lib/overview/attention.test.ts`),
`src/db/queries/attention.ts` (the §8 predicates), plus `AsOfStamp`/`NeedsAttentionQueue`/
`MyWorkCard`/`ActivityTail`.

Deviations from this document, deliberate:

| Spec | What shipped | Why |
|---|---|---|
| B3 as a `<table>` (§12) | A `<ul>` of full-row `<Link>`s | Gives the whole row as a focusable, middle-clickable target at any width with no table→card CSS; §12's real requirement (semantics + keyboard) is met. |
| `/time?filter=unattributed` (C1) | `/time?start=<ISO>` | The filter param does not exist yet; unattributed rows already show in the period view. Add the param when the row proves noisy. |
| Deferred-follow-up row scoped by company | Scoped by RLS only | Deferred hiring docs carry a NULL `company_id`, so a company filter would always return 0. Under-counts if RLS hides NULL-company rows; never over-counts. |
| H5 portal expiring-docs card | Not built | Admin-side scope only this pass. |

---

## 1. Assessment of the existing dashboard

`src/app/(admin)/overview/page.tsx` (351-line server component). Verified findings:

| # | Finding | Evidence | Impact |
|---|---------|----------|--------|
| 1 | **No drill-down anywhere.** All 6 stat tiles render as static `<div cursor:default>` — `StatTile` only becomes a button with `onClick`, and the page passes none. | `src/components/overview/StatTile.tsx:54-66`; usage `overview/page.tsx:206-267` | Dashboard states problems but every fix is a manual nav hunt. |
| 2 | **"updated just now" is a hardcoded string** rendered beside the (honest) `RefreshButton`. | `overview/page.tsx:171-174`; `RefreshButton.tsx:12-26` | Data-freshness claim is false the moment the page sits open. |
| 3 | **Alerts cover only 2 exception classes** (`no_rate`, `no_payout_method`). | `src/db/queries/overview.ts:248-252`; `AlertsBanner.tsx:7-10` | The financially dangerous classes (unconfirmed Wise links, failed payouts, pay-date breach) never surface here. |
| 4 | **"Payout issues" counts only `status='failed'`** — it misses the proven ₱413,770.03 class: rows with a `wise_transfer_id` but no `wise_locked_at` (drafted-but-unfunded / cancelled ghost). The predicate exists and is documented in `isUnconfirmedWiseLink`. | `overview.ts:79-87`; `src/lib/wise/reconcilable.ts:1-27`; counted per-period in `src/server/actions/reconcile.ts:34-54,118` | The single worst money exception in the system is invisible on the money dashboard. |
| 5 | **Pipeline stages lie by "any > 0".** `approved.done = approvedEntries > 0` and `timeImported.done = totalEntries > 0` — one approved entry of 200 shows the stage complete. | `overview.ts:176-183` | Admin reads "approved ✓" and calculates on partially approved time. |
| 6 | **"Data-quality" card promises a check but performs none** — it is three link buttons. | `overview/page.tsx:320-348` | Dead space claiming work it doesn't do. |
| 7 | **Zero role differentiation.** `admin` is fetched only for the login redirect; `isOwner` / `canCountersign` are never read. Owner and scoped admin see identical pages; owner-only Wise staging (`requireOwner`, `src/server/auth/admin.ts:70-74`) has no dashboard presence. | `overview/page.tsx:63-64` | Countersigners never see their queue; owners never see AR or reconcile state. |
| 8 | **No aging, no ownership.** Counts only ("7 pending") — never "oldest pending 12 days". No item is assigned to anyone (no such column exists — see Appendix A). | `overview/page.tsx:205-268` | Can't tell a fresh backlog from a rotting one. |
| 9 | **Page blocks on 12 parallel queries before any byte renders** — one `Promise.all`, no Suspense streaming; slowest query gates LCP for the whole page. | `overview/page.tsx:86-112` | LCP hostage to the slowest of 12 Supabase round-trips. |
| 10 | **Cron machinery computes exception sets the dashboard ignores.** Doc-expiry and hiring-review digests classify overdue/expiring/pending/deferred docs daily, email-only. | `src/app/api/cron/doc-expiry/route.ts:14-33`; `hiring-review/route.ts:15-37`; `src/db/queries/documents.ts:242-318` | Same computation, no on-screen surface; email is the only consumer. |
| 11 | **Correction to the brief:** the contractor portal **does** have a dashboard — greeting, announcements, arrears-correct pay timeline, activity chart, pending-doc overlay, tools popup. | `src/app/portal/(authed)/page.tsx:109-119`; `src/components/portal/PortalDashboard.tsx` | Portal needs additions (own expiring docs), not a from-scratch dashboard. |
| 12 | What works and must be kept: arrears period logic (`overview/page.tsx:76-82`), integer-centavos money handling (`117-125`), coverage `measured=0 → '—'` honesty (`253-267`, `coverage.ts:221-226`), parallel head-count queries (`overview.ts:20-24`), `cache()`d period summaries shared with ⌘K (`payroll.ts:1133-1164`). | — | Redesign is additive on a sound data layer. |

---

## 2. User roles and their dashboard needs

| Role | Code identity | Top questions (in order) | Today gets |
|------|--------------|--------------------------|------------|
| **Owner** | `admin_users.role='owner'`; passes `requireOwner` (`src/server/auth/admin.ts:70-74`); sees all companies | Did money actually leave? (unconfirmed Wise links, failed payouts) · What must I pay before `pay_date`? · What's locked-unpaid ₱? · Is USD AR coming in? · Is the team compliant? | Same generic page as everyone |
| **Scoped admin** | `role='admin'` + `admin_companies` rows (`admin.ts:42-48`) | What's blocking this company's payroll run? (approvals, rates, attribution) · Which docs need review? · Who's stalled in onboarding? | Same page; correctly company-scoped via `getSelectedCompanyId`, but sees owner-shaped money framing for actions they cannot take |
| **Countersigner** | `admin_users.can_countersign=true` (a permission, not a role — either of the above) | Which signed agreements await my countersignature? | Nothing — must open `/onboarding/[workerId]` one by one (`OnboardingDetailBody.tsx:598` gates the button) |
| **Contractor** | `contractor_logins` → RLS `my_worker_id()` + `is_onboarded()` (`docs/data-model.md` §RLS) | When am I paid, how much, what do I still owe (docs/onboarding)? | A working dashboard (`PortalDashboard.tsx`); missing: own expiring documents |

---

## 3. Operational vs analytical vs executive requirements

| Class | Definition here | Belongs on | Examples |
|-------|-----------------|-----------|----------|
| **Operational** (default; this app is an ops tool) | "What must a human do next, and how late is it?" | `/overview` top ⅔ — alerts, Needs-Attention queue, My Work, cycle pipeline | Unconfirmed Wise links, pending approvals + age, docs to review, pay-date countdown |
| **Analytical** | "Why did a number move; where's the pattern?" | Existing deep pages, NOT the dashboard: `/reports`, `/coverage`, `/batches`, `/audit` | Per-contractor YTD (`reports.ts:141`), paid-vs-tracked variance, reconcile history |
| **Executive** | "Is the business healthy this month?" | `/overview` bottom strip, owner variant only | Net-payroll trend (existing `NetSparkline`), locked-unpaid liability, AR outstanding |

Rule applied throughout: an element that doesn't name a next action or feed the two executive questions above is cut. Killed: standalone "Active contractors" count (context, moved to header sub-line), "Data-quality" card (finding #6), the 6-tile grid as a format (replaced by linked queue + 4 linked indicators).

---

## 4. Major usability and IA problems

1. **Read-only dead end** — every element is display-only (finding #1); the page is a status poster, not a work surface.
2. **Severity is flattened** — ₱413k of ghost-linked payments (if surfaced at all) would get the same visual weight as "2 docs to review". No critical band exists.
3. **Counts without age** — "Time pending approval: 41" is unactionable without "oldest is 12 days old" (finding #8).
4. **Double counting and vague sums** — "Docs & onboarding" adds two unlike things (`pendDocs + onbOpen`, `overview/page.tsx:129-131`); "Contractors needing setup" is a `Set` over the same alerts already shown in the banner (`135`), so one worker appears twice on screen.
5. **The two most dangerous states are off-dashboard** — unconfirmed Wise links live only inside `/batches` after a manual period pick; unattributed time (`time_entries.worker_id IS NULL`) surfaces only during import flows (`TimeApprovalTable.tsx:261-273`), never as a standing exception.
6. **No "mine"** — countersigners and owners have exclusive duties with zero dashboard presence (finding #7).
7. **Trust erosion** — fake freshness stamp (#2), pipeline "done" semantics (#5), and a "check" that isn't (#6) teach users to distrust the page.
8. **Nav is fine** — `nav.ts` workflow grouping, ⌘K, and the 4-pin mobile bottom-nav (`AdminShell.tsx:44-49,327-380`) all work; the problem is the Overview content, not the shell. No IA changes proposed outside `/overview`.

---

## 5. Recommended dashboard hierarchy

Adapted to this product (semi-monthly arrears payroll, manual early payment, Wise reconciliation):

```
B1 Compact header      — company · arrears-cycle chip · honest "as of" · Refresh
B2 Critical alerts     — money-risk only, 0–3 banners, each linked
B3 Needs Attention     — unified aged exception queue (the page's center of gravity)
B4 My Work             — role-derived queue (countersign / owner money duties)
B5 Cycle indicators    — pipeline (fixed semantics) + net + 4 linked KPI tiles
B6 Trend               — NetSparkline (kept as-is)
B7 Recent activity     — audit_log tail, 8 rows
```

### Master element table

Every proposed element: role · question it answers · data behind it · action it enables · click target · why it earns space.

| Element | Role(s) | Question | Data (table/column) | Action enabled | Click target | Why it earns space |
|---|---|---|---|---|---|---|
| B1 company + count sub-line | All admins | Where am I; how big is the roster? | `companies.name`; `worker_companies` count `status='active'` (`overview.ts:19-27`) | Orientation only | — (switcher is in topbar) | One line; prevents cross-company mistakes for scoped admins |
| B1 cycle chip | All admins | Which cycle is being worked; what state; how long to deadline? | `previousPeriod(today)`; `pay_periods.state`, `pay_date` (`overview/page.tsx:76-82,152`) | Jump into the run | `/payroll?period=<start>` | The single most-asked question in a payroll app |
| B1 "as of HH:MM" + Refresh | All | Is this stale? | Server render timestamp (RSC render time) | `router.refresh()` (existing `RefreshButton`) | — | Replaces the false "updated just now" (finding #2) |
| B2 unconfirmed-Wise-links banner | **Owner** | Is any "paid" row pointing at money that never moved? | `payments`: `payout_method='wise' AND wise_transfer_id IS NOT NULL AND wise_locked_at IS NULL` (`reconcilable.ts:26-27`) | Open reconcile, cancel/confirm drafts | `/batches` | ₱413k class; proven live failure mode; owner-only because fixing needs Wise access |
| B2 failed-payouts banner | Owner, scoped admin | Did a send fail? | `payments.status='failed'` (`overview.ts:79-87`) | Re-stage the payout | `/process?period=<uuid>` of affected period | Blocking a contractor's pay |
| B2 pay-date banner | Owner, scoped admin | Is a deadline ≤3 days out (or breached) with unpaid rows? | `pay_periods.pay_date`, `state != 'paid'`, unpaid `payments.status IN ('draft','queued','failed')` | Pay before deadline | `/process?period=<uuid>` | `pay_date` is a hard deadline (payment is manual & usually early — a *late* one is exceptional and urgent) |
| B3 queue rows (spec in §8) | Per-row | What needs a human, how old is it, how big? | Row-type-specific (§8 table) | One-click to the fixing surface | Per-row (§8) | Replaces 6 dead tiles + 2 banners with one ranked, aged, linked list |
| B4 countersign queue | Countersigner | Which agreements await my signature? | `onboarding_signatures.status='signed'` joined to `onboarding_agreements.countersigned_at IS NULL`, worker active | Countersign | `/onboarding/[workerId]` | The capability exists (`can_countersign`) with zero surfacing today |
| B4 owner duty list | Owner | What can only *I* do right now? | Union: unconfirmed links, `readySent` reconcile count (`reconcile.ts:44,131`), locked periods awaiting send | Stage/send/reconcile | `/process?period=…`, `/batches` | `requireOwner` gates these actions; the dashboard should mirror that |
| B5 pipeline strip (fixed) | Owner, scoped admin | Where is this cycle in time→approve→calc→lock→pay? | `getPipelineData` (`overview.ts:112-198`) with **done = all** (`approved.done = approvedEntries === totalEntries && totalEntries > 0`), partial state shown as "n of m" | Jump to the stage that isn't done | Stage-mapped: `/time?start=…`, `/payroll?period=…`, `/process?period=…` | Kept because the mental model is right; semantics fixed (finding #5) |
| B5 net-this-cycle | Owner, scoped admin | What does this cycle cost? | `pay_period_summaries.total_net_php` for the arrears period | Sanity-check before lock | `/payroll?period=<start>` | Anchor number for the whole run |
| B5 KPI tiles ×4 (§7: locked-unpaid ₱, approval backlog+age, docs overdue/expiring, onboarding open/stalled) | Varies (§6) | §7 per-KPI | §7 | §7 | §7 | Only exception-bearing KPIs kept; each is now a `<Link>` |
| B6 NetSparkline + Δ% | Owner (scoped: optional) | Is payroll cost drifting? | `pay_period_summaries` last 6 locked/paid (`overview.ts:214-242`) | Investigate | `/reports` | Already built; the one earned trend |
| B7 activity tail | All admins | What just changed (and who did it)? | `audit_log` last 8 rows, `company_id` scoped | Verify/undo via the named surface | `/audit?from=…` (params exist: `audit/page.tsx:12-17`) | Cheap trust-builder; append-only table already exists |
| Portal: own expiring docs card | Contractor | Do I owe a document renewal? | `documents` via RLS: `worker_id=my_worker_id() AND expires_on <= today+30 AND storage_path IS NOT NULL` | Upload replacement | `/portal/docs` | Closes the loop the admin-side expiry digest already opens |

---

## 6. Role-specific dashboard configurations

Blocks are **omitted server-side** for roles that can't act on them (never rendered-then-hidden; see §12 security).

| Block | Owner | Scoped admin | Countersigner (either role) | Contractor (portal) |
|---|---|---|---|---|
| B1 header + cycle chip | ✓ | ✓ (selected company only) | ✓ | pay-timeline equivalent exists (`PortalPayActivity`) |
| B2 unconfirmed Wise links | ✓ | — (cannot act; `requireOwner` gates staging) | — | — |
| B2 failed payouts / pay-date | ✓ | ✓ | — | — |
| B3 Needs Attention queue | ✓ full | ✓ (company-scoped rows only) | ✓ (their admin role's view) | — |
| B4 My Work | Owner duty list | — (empty state: "No items need the owner — nothing assigned to you") | Countersign queue appended to their admin view | — |
| B5 pipeline + net + KPI tiles | ✓ all | ✓ minus AR | ✓ (per admin role) | — |
| B6 NetSparkline | ✓ | ✓ (their company's series) | per role | activity chart exists |
| B7 audit tail | ✓ | ✓ (company-scoped) | per role | — |
| AR outstanding (in B5, owner) | ✓ | — | — | — |
| Own expiring docs | — | — | — | ✓ NEW |

Countersigner note: it's a boolean on either role, so it *adds* the B4 countersign queue to whichever base layout applies (`admin.canCountersign`, `admin.ts:56`).

---

## 7. KPI definitions

All computed at request time (RSC, no ISR cache) against the RLS/selected-company scope; "freshness" = honest as-of stamp (B1). Money in integer centavos via existing conversion (`overview/page.tsx:117-125`).

| KPI | Formula (real tables/columns) | Time period | Target / comparison | Drill-down |
|---|---|---|---|---|
| **Net payroll this cycle** | `SUM(payments.net_php)` for the arrears period, via `pay_period_summaries.total_net_php` (`payroll.ts:1133-1164`) | `previousPeriod(today)` | Δ% vs prior period (existing calc, `overview/page.tsx:139-150`) | `/payroll?period=<period_start>` (ISO date — `payroll/page.tsx:52-58`) |
| **Locked, unpaid liability** | `COUNT` + `SUM(total_net_php)` over `pay_period_summaries WHERE state='locked'` (existing `draftN/draftNet`, `overview/page.tsx:123-125`) | All periods | 0 outside the pay window; any value with `pay_date − today ≤ 3` escalates to B2 | One locked period → `/process?period=<uuid>`; several → `/payroll` |
| **Time-approval backlog + age** | `COUNT(time_entries) WHERE approval='pending'` (`overview.ts:64-72`) + `today − MIN(work_date)` over the same set (new min query) | All time | 0 before Calculate; age > 7d escalates tone to `warn` | `/time?start=<period_start>` (`time/page.tsx:27,56-58`) |
| **Unconfirmed Wise links** | `COUNT` + `SUM(net_php)` over `payments WHERE payout_method='wise' AND wise_transfer_id IS NOT NULL AND wise_locked_at IS NULL` (`reconcilable.ts:26-27`) | All time | Always 0; anything else is B2-critical | `/batches` |
| **Failed payouts** | `COUNT(payments) WHERE status='failed'` (`overview.ts:79-87`; enum `types.ts:1843`) | All time | 0 | `/process?period=<uuid>` of the affected period |
| **Docs overdue / expiring** | `documents WHERE expires_on < today` (overdue) / `≤ today+30` (soon), `storage_path IS NOT NULL`, worker active — the digest's exact predicate (`documents.ts:242-284`) | Rolling 30d lookahead | 0 overdue | `/documents` |
| **Onboarding open / stalled** | `onboarding_progress.completed_at IS NULL`; stalled = existing `stalled` column OR `updated_at < now()−14d` (`onboarding.ts:79`) | Current | 0 stalled | `/onboarding`; row → `/onboarding/[workerId]` |
| **AR outstanding (owner)** | `SUM(total_usd − COALESCE(amount_received_usd,0))` over `invoices WHERE status='sent'` (`invoicing.ts:233-260`, statuses `draft/sent/paid/void`) | All open invoices | Trend vs prior month; aging proxied by `period_end` (see Appendix A) | `/invoicing` |
| **Coverage gaps** | Existing `getCoverageGaps` — gaps of `measured`, `'—'` when `measured=0` (`coverage.ts:215-235`) | Arrears period | 0 gaps of measured | `/coverage` |

Killed as KPIs: "Active contractors" (context → B1 sub-line), "Contractors needing setup" (duplicate of alert classes — folded into §8), "Docs & onboarding" combined sum (split into the two honest KPIs above).

---

## 8. Alert & exception rules

Severity: **critical** = money wrong/at deadline (`--bad`, B2 banner + queue) · **warn** = blocks the run or compliance (`--warn`, queue) · **info** = routine work (queue). "Owner" = accountable role (no per-person assignment exists — Appendix A).

| Class | Trigger predicate (real columns) | Severity | Owner | Next action | Link target |
|---|---|---|---|---|---|
| **Unfunded/ghost Wise draft** | `payments.payout_method='wise' AND wise_transfer_id IS NOT NULL AND wise_locked_at IS NULL` (`reconcilable.ts:26-27`) — regardless of `status`, incl. rows already stamped `sent`/`reconciled` (`reconcile.ts:47-51`) | critical | Owner | Cancel the draft (action exists, commit `e23fdb2`) or confirm via poll/match | `/batches` |
| **Reconciliation variance / ghosts** | Per-period rollup from `getReconcileOverview`: `unconfirmed > 0` or `unmatchedWise > 0` (sent Wise rows with no matched transfer) (`reconcile.ts:34-62,118-124`) | critical if `unconfirmed>0`, else warn | Owner | Run match, link/unlink, attribute variance (`wiseAttributeVariance`, `BatchesClient.tsx:30,218`) | `/batches` |
| **Failed payout** | `payments.status='failed'` | critical | Owner / scoped admin | Fix payout method or re-stage | `/process?period=<uuid>` |
| **Pay-date approaching/breached** | `pay_periods.state != 'paid' AND pay_date − today ≤ 3` AND period has `payments.status IN ('draft','queued','failed')`. Never infer from `paid_at` — `pay_date` is the deadline; payment is manual and normally early | critical at ≤1d or breach; warn at 2–3d | Owner | Send the batch | `/process?period=<uuid>` |
| **Missing rate** | Worker has `time_entries.approval='approved'` in the arrears period and no `rates` row covering it (`overview.ts:258-308`, existing) | warn | Scoped admin | Add an effective-dated rate | `/contractors/[workerId]` (per-worker link — today's banner names but doesn't link) |
| **Missing payout method** | `payments.payout_method IS NULL` for the arrears period (`overview.ts:311-337`, existing) | warn | Scoped admin | Set payout method | `/contractors/[workerId]` |
| **Unattributed time** | `time_entries.worker_id IS NULL` count > 0 (company-scoped). Today only visible during import (`time/page.tsx:91`, `TimeApprovalTable.tsx:261-273`) | warn | Scoped admin | Match source names to contractors | `/time?start=<period_start>` (`?filter=unattributed` param is new — Critical tier) |
| **Doc overdue / expiring ≤30d** | Digest predicate: `expires_on` past/≤30d out, `storage_path IS NOT NULL`, worker active (`documents.ts:242-284`) | warn (overdue) / info (soon) | Scoped admin | Request + review replacement | `/documents` |
| **Deferred follow-up overdue** | `documents.review_status='deferred' AND defer_until < today` (`onboarding.ts:114-136`) | warn | Scoped admin | Chase the deferred doc | `/onboarding/[workerId]` |
| **Onboarding stalled** | `onboarding_progress.completed_at IS NULL AND (stalled OR updated_at < now()−14d)`; include `name_mismatch_flag` rows (`onboarding.ts:79`) | warn | Scoped admin | Nudge worker / fix mismatch | `/onboarding/[workerId]` |
| **Docs pending review** | `documents.review_status='pending'`, aged by `created_at` (`documents.ts:291-318`) | info | Scoped admin | Approve / reject | `/documents` |
| **Sessions pending approval** | `service_sessions.approval='pending'` | info | Scoped admin | Approve sessions (blocks PS/PHS pay + billing — only approved count, `docs/data-model.md`) | `/sessions` |
| **Countersign waiting** | `onboarding_signatures.status='signed'` AND matching `onboarding_agreements.countersigned_at IS NULL`, worker active (`onboarding.ts:43`; action `onboarding.ts:382`) | info | Countersigner | Countersign | `/onboarding/[workerId]` |
| **Coverage gap** | Existing `classifyCoverage` under 60% threshold (`coverage.ts:215-235`) | info | Scoped admin | Investigate hours | `/coverage` |

Queue rendering rule: B3 shows each class as one row — `label · count (+ ₱ where money) · oldest-item age · link`. Critical classes ALSO render a B2 banner. Row order: severity desc, then age desc. Cap 10 rows; footer "view all" per surface.
Dedupe rule: a worker in `missing rate` does not also increment a "needs setup" count anywhere (kills finding-§4 double counting).

---

## 9. Wireframes

### Desktop ~1440 (owner variant)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR (existing AdminShell: navy/gold, company switcher, ⌘K, user)      78px    │
├─────────┬─────────────────────────────────────────────────────────────────────────┤
│ SIDEBAR │ B1 ┌───────────────────────────────────────────────────────────────┐   │
│ 212px   │    │ Overview · Aaron Anderson E.H.S. · 24 active contractors      │   │
│ (nav.ts │    │ [Cycle: Jul 16–31 · Locked · pay day in 3 days →]  as of 9:41 │   │  ← chip links /payroll?period=2026-07-16
│ groups, │    └───────────────────────────────────────────────────[↻ Refresh]─┘   │
│ un-     │ B2 ┌───────────────────────────────────────────────────────────────┐   │
│ changed)│    │ ⛔ 3 Wise links unconfirmed — ₱58,200 may not have moved  →   │   │  ← /batches   role=alert, --bad-soft
│         │    │ ⚠ Pay day Jul 31 in 3 days — 24 payments not sent         →   │   │  ← /process?period=<uuid>, --warn-soft
│         │    └───────────────────────────────────────────────────────────────┘   │
│         │ ┌── B3 NEEDS ATTENTION (8) ───────────────────┐ ┌─ B4 MY WORK ─────┐  │
│         │ │ TYPE            ITEMS      OLDEST    →      │ │ (owner)          │  │
│         │ │ ⛔ Wise unconf.  3 · ₱58.2k    41d   Batches │ │ Send Jul 16–31   │  │
│         │ │ ⚠ No rate       Reyes, D.      —    Fix     │ │  24 pmts ₱642k → │  │  ← /process?period=<uuid>
│         │ │ ⚠ Unattributed  5 entries      3d   Match   │ │ Reconcile 12     │  │  ← /batches
│         │ │ ⚠ Doc overdue   2 docs        12d   Review  │ │  confirmed     → │  │
│         │ │ ⚠ Onb. stalled  1 worker      19d   Open    │ │ Countersign 2 →  │  │  ← only if can_countersign
│         │ │ ⓘ Time pending  41 entries     6d   Approve │ └──────────────────┘  │
│         │ │ ⓘ Docs review   4 docs         2d   Review  │  (empty: "Nothing     │
│         │ │ ⓘ Sessions      7 pending      1d   Approve │   needs the owner ✓") │
│         │ │            view all on each surface →       │                       │
│         │ └─────────────────────────────────────────────┘                       │
│         │ B5 ┌───────────────────────────────────────────────────────────────┐  │
│         │    │ Time 312/312 ▸ Approved 271/312 ▸ Calc 24 ▸ Locked ▸ Paid 0/24│  │  ← each stage links; "n of m" not ✓-if-any
│         │    │ Net this cycle ₱642,310.55 (Δ +2.1%)                          │  │
│         │    └───────────────────────────────────────────────────────────────┘  │
│         │ B5 ┌─────────────┬─────────────┬─────────────┬─────────────┐          │
│         │    │ Locked      │ Approval    │ Docs        │ AR          │          │  ← 4 linked KPI tiles (ov-grid,
│         │    │ unpaid      │ backlog     │ overdue     │ outstanding │          │    StatTile + href). Scoped admin:
│         │    │ 1 · ₱642k → │ 41 · 6d  →  │ 2 (+5 soon)→│ $12,400  →  │          │    AR slot ⇒ Onboarding open/stalled
│         │    └─────────────┴─────────────┴─────────────┴─────────────┘          │
│         │ ┌── B6 NET TREND (6 periods) ─────────────┐ ┌─ B7 RECENT ACTIVITY ─┐  │
│         │ │  NetSparkline (existing)        /reports│ │ 9:12 lock Jul 16–31  │  │
│         │ │                                         │ │ 8:55 rate + Reyes    │  │
│         │ └─────────────────────────────────────────┘ │ …8 rows      /audit →│  │
│         │                                             └──────────────────────┘  │
└─────────┴────────────────────────────────────────────────────────────────────────┘
```

Scoped-admin deltas: B2 drops the Wise-unconfirmed banner; B4 shows countersign queue or role-appropriate empty state; AR tile ⇒ Onboarding tile; everything already scoped by `getSelectedCompanyId`.

### Mobile ~390 (bottom-nav shell unchanged: Overview/Team/Time/Calculate + More — `AdminShell.tsx:44-49`)

```
┌─────────────────────────────┐
│ TOPBAR (compact)            │
├─────────────────────────────┤
│ B1  Aaron Anderson E.H.S.   │
│ [Jul 16–31 · Locked · 3d →] │
│ as of 9:41        [↻]       │
├─────────────────────────────┤
│ B2 ⛔ 3 Wise unconfirmed    │
│    ₱58.2k               →   │
│ B2 ⚠ Pay day in 3 days  →   │
├─────────────────────────────┤
│ B3 NEEDS ATTENTION (8)      │
│ ┌─────────────────────────┐ │   ← existing .table-scroll
│ │⛔ Wise unconf. 3 · 41d →│ │     card-ification handles
│ │⚠ No rate — Reyes     → │ │     table→cards <768px
│ │⚠ Unattrib. 5 · 3d    → │ │     (globals.css:601-692)
│ │⚠ Doc overdue 2 · 12d → │ │
│ │ⓘ Time 41 · 6d        → │ │
│ │      + 3 more…          │ │   ← top 5, expand in place
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ B4 MY WORK                  │
│ Send Jul 16–31 · ₱642k  →   │
│ Countersign 2           →   │
├─────────────────────────────┤
│ B5 pipeline (horiz scroll)  │
│ Net ₱642,310.55 (+2.1%)     │
│ ┌──────────┬──────────┐     │
│ │Locked  → │Backlog → │     │   ← 2-col KPI grid
│ ├──────────┼──────────┤     │
│ │Docs    → │AR      → │     │
│ └──────────┴──────────┘     │
├─────────────────────────────┤
│ B6 sparkline (collapsed:    │
│    "Net trend ▸" expands)   │
│ B7 activity: 4 rows /audit →│
└─────────────────────────────┘
```

All touch targets ≥24×24 CSS px (WCAG 2.2 §2.5.8); queue rows are full-width links.

---

## 10. Interaction and navigation behavior

| Behavior | Spec |
|---|---|
| **Drill-down** | Every count/amount is a `<Link>` with real params: `/payroll?period=<ISO-start>` (+`&unlock=1` where the flow needs it, `payroll/page.tsx:15`), `/process?period=<uuid>` (`process/page.tsx:38`), `/time?start=<ISO>` / `?unpaid=1` (`time/page.tsx:27`), `/audit?q=&from=&to=` (`audit/page.tsx:12-17`), `/contractors/[workerId]`, `/onboarding/[workerId]`. NOTE the asymmetry: payroll takes a **date**, process takes a **uuid** — dashboard links must not swap them. |
| **Filter persistence** | URL params only (existing pattern) — links are shareable and survive refresh; no dashboard-local filter state. Precedent for device-level prefs: `localStorage` `abc_sidebar_collapsed` (`AdminShell.tsx:40`) — reused for "sparkline collapsed" on mobile, nothing else. |
| **Saved views** | Not built (Later tier). The queue is already the one saved view that matters: severity-ordered exceptions. |
| **Refresh policy** | No polling, no auto-refresh timers. (a) Honest "as of" stamp from RSC render time; (b) existing `RefreshButton` → `router.refresh()` re-runs server components without losing client state (`RefreshButton.tsx:12-26`); (c) Later tier: `document.visibilitychange` → `router.refresh()` when the tab was hidden >5 min — never while visible, so a review/edit in a modal or `/process` is never interrupted; `useUnsavedGuard` continues to guard dirty forms. |
| **Confirmations** | The dashboard itself performs **no mutations** — every action is a link to the surface that owns the confirmation (e.g. Reconcile-all's transfer-id confirm per `d3af989`, `ConfirmDangerModal` for unlink `BatchesClient.tsx:837-849`). This keeps the dashboard idempotent and safe to leave open. |
| **⌘K** | Unchanged; already indexes sections/contractors/periods via the same `cache()`d `fetchPeriodSummaries`. |

---

## 11. Loading, empty, error, incomplete-data, permission-denied states

Four distinct meanings, never conflated (the coverage tile already models this — extend it everywhere):

| State | Meaning | Treatment | Precedent |
|---|---|---|---|
| **Zero** (good) | Query ran, nothing to do | Tone `good`, affirmative text ("All time approved", "No unconfirmed links") — a zero-exception dashboard should read as a green page | `StatTile` tone system, `overview/page.tsx:215-251` |
| **Unavailable** (error) | Block's query failed | Per-block failure, page still renders: tile/queue-section shows "Couldn't load — press Refresh" in `--bad`; wrap each block's RSC in an error boundary so one failed query no longer 500s the page (today any throw in the `Promise.all` kills everything, `overview/page.tsx:86-112`) | `StatTile error` prop (`StatTile.tsx:11,30-49`); `RouteError` |
| **Incomplete** (unmeasurable) | Data to compute it doesn't exist | Show `'—'` + why: coverage `measured=0` → "No coverage targets set"; net total `null` when no payments (`overview.ts:53`) → "Not calculated yet", never "₱0" | `coverage.ts:221-226`; `overview/page.tsx:118-119` |
| **N/A** (permission) | Role can't act on it | Block **omitted server-side** — not rendered, not greyed, no "locked" teaser (prevents information leakage about other companies/money state) | §12 security |
| **Loading** | Streaming in | Per-block `<Suspense>` skeleton with **fixed min-heights** matching final render (CLS §12); B1 renders immediately (no queries beyond cached admin/company) | `loading.tsx` boundaries exist per route |
| **Empty queue** | No exceptions at all | Single `EmptyState` ("Nothing needs attention ✓") replacing the whole B3 block | `src/components/ui/EmptyState.tsx` |

---

## 12. Accessibility, performance, privacy & security

### Accessibility (WCAG 2.2 AA)

- **Landmarks/headings**: one `<h2>` per block; queue is a real `<table>` with `aria-label`, scope-ed `<th>` (pattern already used, `overview/page.tsx:278-295`).
- **Alerts**: keep `role="alert"` on B2 banners (`AlertsBanner.tsx:25`) — but only for content present at load; refresh-added banners use `aria-live="polite"` to avoid double-announce.
- **Color never alone**: every tone pairs icon + text ("⛔ … unconfirmed"), not color only; tokens `--good/--warn/--bad` already AA on `--card` (`--subtle` pre-darkened, `globals.css:25`).
- **Links not buttons**: tiles/queue rows become `<Link>` (real hrefs) — discernible names for AT, middle-click works; focus style via existing `--ring`.
- **2.5.8 target size**: queue rows and mobile KPI tiles ≥24px targets; bottom-nav already compliant.
- **2.4.11 focus not obscured**: sticky topbar (`--topbar-h`) — ensure `scroll-margin-top` on focusable blocks.
- **Reduced motion**: sparkline and pipeline get `@media (prefers-reduced-motion: reduce)` (static render; no new animation introduced anyway, `--dur` is 0.16s token).
- **Emoji icons**: keep `aria-hidden="true"` (already done, `StatTile.tsx:35`).

### Performance (LCP ≤2.5s · INP ≤200ms · CLS ≤0.1), given RSC + Supabase

- **Stream, don't block**: replace the single 12-query `Promise.all` with one async server component per block, each inside `<Suspense>`. B1 (company name from `cache()`d `listCompanies` + render clock) streams in the first flush → **LCP is the header text**, independent of the slowest query.
- **Cheapest queries win the fold**: counts stay `head:true count:'exact'` (existing pattern, `overview.ts:20-24`); B3 needs ~8 count/min queries fired in parallel inside its own block; `fetchPeriodSummaries` is already request-`cache()`d and shared with the ⌘K palette (`payroll.ts:1133-1164`) — reuse, don't refetch.
- **Region**: Vercel function region must track the Supabase region (pdx1 — see `docs/DEPLOY.md` topology note); budget ≈ 1 RTT × slowest parallel batch per block, not the sum.
- **INP**: dashboard stays ~fully RSC; the only client components remain `RefreshButton`, `CommandPalette`, shell nav. Queue rows are plain `<Link>`s (no handlers). No new client JS on the critical path.
- **CLS**: every Suspense skeleton has the block's fixed `min-height`; tiles keep the `.ov-grid` fixed layout; the as-of stamp reserves width (no layout shift when time changes).
- **Fonts**: already self-loaded correctly (fix `aad010b`) — no swap-shift.

### Privacy & security

- **RLS is the boundary, not the UI**: every dashboard query runs on the RLS user client (`createServerSupabase`), same as today (`overview.ts:3-4`). Role-gated blocks are *additionally* omitted server-side, but omission is presentation — the data reads must themselves be scope-safe.
- **Scoped admins**: all block queries take `companyId` from `getSelectedCompanyId()` (which validates against `admin_companies`); B3/B7 never aggregate across companies. Server actions reused by the dashboard keep their explicit scope checks (`reconcile.ts:72-75`).
- **PHI**: `onboarding_signatures.signature_data` is encrypted PHI and immutable — the countersign queue renders worker name + `agreement_kind` + `signed_at` **only**; never signature payloads, never `ip_address`.
- **No cross-role leakage**: N/A blocks are not rendered as locked teasers (a scoped admin must not learn "there are 3 unconfirmed Wise links" for a company they can't see — or at all, since acting on them is owner-only).
- **Safe notification content**: existing email digests already name docs/workers without file contents (`documents/service.ts:103-116`) — keep that rule for any future dashboard-driven notification: names, kinds, dates, counts; never document contents, signatures, or bank/payout details.
- **Legacy portal caveat**: the same DB serves portal.abbilabs.com under RLS — dashboard work adds **no new policies and no schema changes**, so no cutover risk. Anything in Later tier that writes (cron heartbeat) is additive-only per `docs/shared-prod-conformance.md`.

---

## 13. Components: reuse vs new

### Reuse as-is

| Component | File | Used for |
|---|---|---|
| PipelineStrip | `src/components/overview/PipelineStrip.tsx` | B5 (data-shape change only, §8/§5) |
| NetSparkline | `src/components/overview/NetSparkline.tsx` | B6 unchanged |
| RefreshButton | `src/components/overview/RefreshButton.tsx` | B1 unchanged |
| Badge | `src/components/ui/Badge.tsx` | Severity/status chips in queue |
| EmptyState | `src/components/ui/EmptyState.tsx` | Empty queue / empty My Work |
| Spinner | `src/components/ui/Spinner.tsx` | Inside Suspense fallbacks |
| AdminShell + nav + CommandPalette | `src/components/shell/AdminShell.tsx`, `nav.ts`, `CommandPalette.tsx` | Unchanged shell |
| CSS system | `globals.css` — `.ov-grid/.ov-tile` (910-945), `.banner`, `.table-scroll` card-ification (601-692), tokens | All blocks; **no new design language** |
| PortalDashboard / PortalPayActivity | `src/components/portal/*` | Portal; one added card |

### Modify (small)

| Component | File | Change |
|---|---|---|
| StatTile | `src/components/overview/StatTile.tsx` | Add optional `href` → renders `<Link>` (keeps `onClick`/static variants); ~10 lines |
| AlertsBanner | `src/components/overview/AlertsBanner.tsx` | Generalize to `{severity, text, href}[]`; per-worker links for existing kinds |
| getPipelineData | `src/db/queries/overview.ts:112-198` | `done` = complete-not-any; expose `n of m` detail |

### New (all server components unless noted)

| Component | Purpose |
|---|---|
| `src/components/overview/AsOfStamp.tsx` | Renders server time "as of 9:41 AM" (zero client JS) — replaces the lie |
| `src/components/overview/NeedsAttentionQueue.tsx` | B3 table: severity icon, label, count/₱, oldest age, link |
| `src/components/overview/MyWorkCard.tsx` | B4; branches on `isOwner` / `canCountersign` |
| `src/components/overview/ActivityTail.tsx` | B7; 8 `audit_log` rows |
| `src/db/queries/attention.ts` | The §8 predicates as count/min queries; imports `isUnconfirmedWiseLink` from `src/lib/wise/reconcilable.ts` rather than re-deriving |
| Block skeletons | CSS-only fixed-height placeholders (a `.skeleton` class in `globals.css`) |

Explicitly **not** new: charting libs, client state stores, a notification framework, any dependency.

---

## 14. Prioritized implementation plan

### Critical (fixes lies and surfaces money risk — ship first)

| # | Item | Touches |
|---|---|---|
| C1 | StatTile `href` + link every existing tile/banner to its §7/§8 target; add `/time` `?filter=unattributed` param | `StatTile.tsx`, `overview/page.tsx`, `time/page.tsx` |
| C2 | B2 critical band: unconfirmed Wise links (count+₱), failed payouts, pay-date ≤3d — predicates from `reconcilable.ts` + §8 | `attention.ts` (new), `AlertsBanner.tsx` |
| C3 | Honest as-of stamp (delete the static string) | `AsOfStamp.tsx`, `overview/page.tsx:171-174` |
| C4 | Needs Attention queue v1: the §8 classes that need no new params (pending time+age, docs pending/overdue, deferred-overdue, onboarding stalled, unattributed count, missing rate/method as linked rows) | `NeedsAttentionQueue.tsx`, `attention.ts` |
| C5 | Role gating: owner-only blocks (B2-Wise, AR, owner My Work), countersign queue; delete the Data-quality card and dead tiles | `overview/page.tsx`, `MyWorkCard.tsx` |

### High value

| # | Item |
|---|---|
| H1 | Suspense streaming + fixed-height skeletons per block (LCP/CLS budget, §12) |
| H2 | Pipeline "n of m" semantics + stage links (finding #5) |
| H3 | Sessions-pending + coverage rows in queue; B7 audit tail |
| H4 | AR-outstanding owner tile (`invoices` predicate §7) |
| H5 | Portal: own-expiring-docs card (RLS-scoped, `/portal/docs` link) |

### Later enhancement

| # | Item | Why later |
|---|---|---|
| L1 | Cron heartbeat surface ("doc-expiry digest last ran …") | Needs the two cron routes to write an `audit_log` row (additive; today pg_cron "success" ≠ ran) |
| L2 | `visibilitychange` refresh (>5 min hidden) | Nice-to-have; RefreshButton covers the need |
| L3 | Per-item assignment ("claimed by") | Requires new schema — shared-prod DB, additive migration + owner decision |
| L4 | Saved views / queue filters | No demonstrated need yet; URL params cover sharing |

---

## 15. Testable acceptance criteria

1. Every number on `/overview` that is > 0 is (or is inside) an `<a href>` resolving to a real route; zero tiles render `cursor:default` interactive-looking dead ends. (Playwright: assert all `.ov-tile` are links.)
2. The string "updated just now" does not appear in the codebase; B1 shows the server render time and it changes after Refresh.
3. Given a payment row with `payout_method='wise'`, `wise_transfer_id` set, `wise_locked_at` null — a B2 critical banner appears for the owner showing count and ₱ sum, linking to `/batches`; it does **not** render for a scoped admin.
4. Given `payments.status='failed'`, B2 shows a failed-payout banner linking `/process?period=<uuid>` of that row's period.
5. Given a `pay_periods` row with `state='locked'`, `pay_date = today+2`, and ≥1 payment in `('draft','queued','failed')` — the pay-date banner shows "in 2 days"; at `pay_date < today` it reads breached and is critical.
6. Queue rows show oldest-item age: with `time_entries.approval='pending'` and `MIN(work_date) = today−9d`, the row reads "9d".
7. `time_entries.worker_id IS NULL` (n>0, company-scoped) produces an unattributed-time row; clicking lands on `/time` filtered/positioned to show them.
8. Pipeline: 271 of 312 approved renders the Approved stage as incomplete with "271 of 312", not done. All 312 → done.
9. With `admin.canCountersign=true` and a worker having `onboarding_signatures.status='signed'` and `onboarding_agreements.countersigned_at IS NULL` — My Work lists it linking `/onboarding/[workerId]`; with `canCountersign=false` no countersign section renders (absent from HTML, not hidden).
10. Scoped-admin page HTML contains no AR figures, no Wise-unconfirmed data, and no data from companies outside `admin_companies` (assert on rendered payload, not just visibility).
11. Coverage with `measured=0` renders `'—'` + "No coverage targets set"; net total with no payments renders "Not calculated yet", never `₱0.00`.
12. Killing one block's query (mock a Supabase error) renders that block's error state while every other block still shows data (no page-level 500).
13. All-clear state: zero exceptions renders the single EmptyState in B3 and `good`-toned indicators.
14. No PHI: rendered HTML never contains `signature_data` or `ip_address` values from `onboarding_signatures`.
15. Web-vitals on prod (`3a.abbilabs.com`, Vercel analytics): `/overview` p75 LCP ≤2.5s, INP ≤200ms, CLS ≤0.1; first flush contains B1 header text.
16. Axe (or Playwright a11y scan) on desktop + 390px: zero serious/critical violations; queue navigable by keyboard with visible focus.

---

## Appendix A — Assumptions & data gaps

| Gap | Consequence | Honest treatment |
|---|---|---|
| **No assignment/ownership column** on any work item | "Owner" in §8 is a *role*, not a person; "My Work" is capability-derived (`isOwner`, `canCountersign`), not assigned | Per-person claiming = L3, needs additive schema on the shared-prod DB |
| **Wise-side-only drafts are invisible to SQL** — a draft living in Wise with no `payments.wise_transfer_id` row (e.g. July's ₱200,500.22 unfunded drafts) cannot be detected from the DB | Dashboard understates Wise exposure | State it on the B2 banner: "app-linked transfers only — run Poll in Batches for Wise-side truth". Never present the count as exhaustive |
| **No cron execution ledger** — pg_cron/pg_net "success" only proves enqueue | Can't render "digest last ran" | L1: cron routes insert an `audit_log` row (additive); until then the dashboard makes no claims about digests |
| **No `sent_at` on `invoices`** | AR aging can't use true send date | Age by `period_end`, labeled "billed period", not "sent" |
| **`paid_at` must not drive schedule logic** — payment is manual and usually early | Any "late payment" metric derived from `paid_at` vs `pay_date` history would mislead | Only the forward-looking pay-date-deadline alert is specified; no punctuality KPI |
| **`payments.deduction_php` is informational shortfall**, never subtracted | Any dashboard money math must ignore it | Net figures use `net_php` / `total_net_php` only |
| **Freshness is per-render, not per-table** | "as of" stamps the page render, not each source | Acceptable: all queries run in the same request window; no per-block stamps |
| **Stalled threshold (14d) and doc-expiry lookahead (30d) are proposed defaults** | Not owner-confirmed | Constants in `attention.ts`; the hiring-review `reminders` config precedent suggests making them config later if the owner cares |
| **Countersign-pending predicate** joins `onboarding_signatures.status='signed'` to `onboarding_agreements.countersigned_at IS NULL` by `(worker_id, agreement_kind)` | Assumes one live signature per kind (matches the immutable-ledger design) | Verify against prod data before C5 ships |
