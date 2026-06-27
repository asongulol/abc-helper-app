# Load-time optimization plan — 2026-06-26

> Goal: close the "noticeable lag vs the old app" gap. The old app was a single
> `index.html` SPA that authenticated once and navigated client-side; this is a
> Next.js 16.2 (App Router, React 19) app where **every admin/portal route is
> dynamic** (server-rendered per request because the proxy reads the auth
> cookie). So every click pays server round-trips the old app never did.
>
> Method: 6-dimension multi-agent investigation (43 agents) with **adversarial
> verification of every finding against the real code**. Verified severities
> below are the *post-verification* values, not the raw investigator claims.

---

## Root cause (verified)

The felt lag is **per-navigation server round-trips**, dominated by auth — **not**
database indexes or CSS/image weight (the verification pass was explicit: at this
app's scale — one employer, tens of contractors — the missing indexes are
sub-ms to low-single-digit-ms and are dwarfed by auth + render cost).

The three things that actually hurt, in order:

1. **Proxy auth tax on every request *and every prefetch*** — `src/proxy.ts`
   does a network `auth.getUser()` + 1–2 DB lookups on every matched request.
   Landing on the admin shell fires ~15 `<Link>` prefetches, each paying a full
   `getUser` + `admin_users` query in the proxy. (AUTH-1, verified **high**)
2. **Double auth: proxy + render each call `getUser()`** — the React `cache()`
   in the render can't reach the proxy's separate invocation, so ≥2 serial auth
   round-trips per real navigation, plus duplicated identity DB lookups.
   (AUTH-3 / CFG-4, verified **high / medium**)
3. **Portal `getCurrentWorker()` is NOT `cache()`-wrapped** (unlike the admin
   `getCurrentAdmin()` already shipped) — so its 4-round-trip auth chain runs
   twice per portal page (layout + page), 3× on `/portal/docs`.
   (SW-1 = AUTH-2 = CFG-1, verified **high**)

Already shipped last session (Phase 0, done): `cache()` on `createServerSupabase`,
`getCurrentAdmin`, `listCompanies`, `getSelectedCompanyId`, `fetchRoster`,
`fetchPeriodSummaries`. The portal side (#3 above) was the missed mirror.

---

## Prioritized roadmap

### Phase 1 — Quick wins · S effort · low risk · high felt impact · DO FIRST

| # | Fix | Source | Why |
|---|-----|--------|-----|
| 1 | **Wrap `getCurrentWorker` in React `cache()`** (`src/server/auth/worker.ts`), mirroring `getCurrentAdmin`. `requireWorker` inherits it. | SW-1/AUTH-2/CFG-1 **high** | Collapses portal auth from 8→4 round-trips/nav (3× call on `/docs`). One-line, proven pattern, request-scoped (no leak). |
| 2 | **Add `loading.tsx`** for `src/app/portal/(authed)/` (portal home) and `src/app/(admin)/coverage/` — they're the 2 heaviest entry points with NO skeleton today. | RC-6 **medium** | Without it, a soft nav leaves the *old* page frozen until all data resolves — the literal "laggy" symptom. Portal home is the contractor landing page. |
| 3 | **Fold the sequential `my_tools_pending` RPC into the existing `Promise.all`** in `src/app/portal/(authed)/page.tsx` (~line 113). | RC-3a | Removes one free serial round-trip on portal home. |
| 4 | **Drop the extra `auth.getUser()` on the profile page** (`profile/page.tsx:12-16`); expose the auth email from `getCurrentWorker` instead. | AUTH-5 **low** | One redundant round-trip on the "edit my info" page; not auto-deduped by #1 (different call site). |
| 5 | **Parallelize two sequential awaits**: `reports-detail.ts` worker_companies query (runs *after* the full payments scan — make it `Promise.all`); `process/page.tsx:28+40` two independent reads → one `Promise.all`. | SW-4, SW-5 **low** | Pure reorder, no logic change. |
| 6 | **Add a lightweight `fetchRosterIndex(db, companyId)`** selecting only `worker_id, first/middle/last name` for the ⌘K palette; use it in the admin layout (and `/documents`) instead of the 45-column `fetchRoster`. | SW-2 **low** | The shared admin layout pulls the full HR record on every admin route just to build `{id,name}`. |

### Phase 2 — Client bundle / first-load · M effort · low–med risk · high TTI win on hot routes

| # | Fix | Source | Why |
|---|-----|--------|-----|
| 7 | **Introduce `next/dynamic` for modal/wizard components** (`AddContractorWizard` 692 lines, `BulkImportModal`, `PullWiseRecipientsModal`, `MiscModal`, `SessionImportModal`). They already render only behind boolean state. The app uses `next/dynamic` **nowhere** today. | CB-1 **high** | The most-visited routes (contractors, payroll, sessions) eagerly download + parse + hydrate modal JS that most page views never open. |
| 8 | **`optimizePackageImports['@/components/ui']` + deep-import `ToastProvider`** | CB-3 | ❌ **Tried and dropped — measured no-op / regression** (see result below). |
| 9 | **Re-measure chunking after 7+8** | CB-2 | ✅ Done — see result below. |

**✅ SHIPPED & MEASURED (Phase 2, 2026-06-26).** Per-route eager client first-load JS (raw on-disk KB, from the manifest script in "How to measure"), before → after:

- `/contractors` (list): **661 → 362 KB (−45%)** — `AddContractorWizard` (692 lines) + bulk/wise modals now lazy.
- `/onboarding` (list): **656 → 364 KB (−45%)** — same wizard, lazy.
- `/payroll`: 382 → 377 · `/sessions` (admin): 361 → 360 (`MiscModal`/`SessionImportModal` are small).
- **No regressions** on any route (portal stayed flat at baseline).

Empirically dropped (item 8): `optimizePackageImports: ['@/components/ui']` produced **byte-identical** builds — it does **not** apply to a local path-alias barrel in Turbopack (Next 16.2). And deep-importing `ToastProvider` *added* ~16.6 KB to portal routes (chunk reshuffle), so it was reverted. The CB-3 verifier had already flagged its evidence as wrong (the "238 KB UI-kit chunk" was actually an unrelated vendor chunk). **Lesson: the whole win is the `next/dynamic` modal split (CB-1); CB-3 was noise.** The contractors `[workerId]`/`@modal` *detail* routes still sit at ~662 KB — their weight is the profile editor, not modals; a future split target.

### Phase 3 — Proxy auth round-trips · M–L effort · medium risk · the structural nav floor

| # | Fix | Source | Why |
|---|-----|--------|-----|
| 10 | ✅ **SHIPPED** (commit `b891cd0`) — proxy skips the gate on prefetch RSC requests (`isPrefetchRequest` helper, `next-router-prefetch` / `next-router-segment-prefetch`). Verified: unit test + live curl (logged-out prefetch → page-level 307→/login, no proxy round-trip, no leak). | AUTH-1 **high** | Eliminates ~15 admin / 6 portal redundant `getUser`+DB calls fired on every shell paint. |
| 11 | ⏸️ **DEFERRED — shared-auth blast radius.** A `custom_access_token` hook fires for **all 4 apps** sharing the prod Supabase auth (it'd run abc's table lookups for the other apps' users), and the prod SQL can't go via repo migrations (the guard forbids it). **Safer abc-scoped alternative identified:** stamp a per-user audience into `app_metadata` at login provisioning (abc already calls `auth.admin.createUser`) and have the proxy decode the JWT locally to route — no shared hook, no cross-app impact. Pursue that instead if/when wanted. | AUTH-3 / CFG-4 | Removes the proxy's per-nav DB identity lookup. |
| 12 | ⏸️ **DEFERRED — multi-app infra decision.** Asymmetric-key rotation changes JWT verification for **all 4 live apps** at once; it's a Supabase dashboard action (not code) and one-way-ish on the shared prod DB. Coordinate with the other apps + the cutover. `getClaims` is a no-op until then. | AUTH-4 | Local JWT verification (no per-request network) — the real unlock, but cross-app. |

### Phase 4 — Data caching & streaming · M effort · medium risk

| # | Fix | Source | Why |
|---|-----|--------|-----|
| 13 | ✅ **SHIPPED** — `unstable_cache` for the two genuinely **app-global** lookups only: `portal_settings` (singleton id=1, read on the contractor home every visit) and `agreement_templates`. New `src/server/config-cache.ts` reads them via the service client; `revalidateTag(tag, 'max')` wired into the 3 Config write actions (instant read-your-own-writes) + a 1h TTL backstop. **Scoped deliberately:** the RLS-scoped reads (companies/clients/employer/projects) are NOT cached — keying them wrong leaks across tenants on the shared DB, and the chosen pair has no per-tenant axis, so it's leak-proof. | RC-1 **medium** | Removes a DB round-trip from the hot portal home + config/onboarding. Verified the correct Next 16.2 invalidator (`revalidateTag(tag,'max')`) from Next's source — the 1-arg form is deprecated in 16. |
| 14 | ⏭️ **SKIPPED (low ROI).** Route-level `loading.tsx` already paints the skeleton; intra-page Suspense only staggers fast-tiles vs the slow section — a perceived-paint nicety, not a first-byte fix — for medium effort + render-restructure risk. Not worth it. | SW-3 / RC-3b **low** | — |
| 15 | **(Optional, L, separate project) `cacheComponents: true`** for PPR-style static-shell streaming. | CFG-3 / RC-2 | ⚠️ Do **NOT** set `experimental.ppr` — it **throws** a hard error in Next 16.2.9 (merged into `cacheComponents`). Enabling `cacheComponents` requires wrapping every dynamic read in `use cache` or the dynamic routes error — a multi-file refactor. |

### Phase 5 — DB hygiene & future-proofing · S effort · very low risk · NOT the felt-lag cause

Cheap additive indexes; worth doing on the shared prod DB before headcount grows,
but they will not move the needle on current navigation latency.

| # | Fix | Source |
|---|-----|--------|
| 16 | `CREATE INDEX documents_company_created_idx ON documents (company_id, created_at DESC)` | DB-2 **medium** |
| 17 | `CREATE INDEX time_entries_company_approval_date_idx ON time_entries (company_id, approval, work_date)` **and** add a date bound to `countPendingTimeApprovals` (the one genuinely unbounded full-table scan, on overview + process) | DB-3 **medium** |
| 18 | `rates (company_id)`; `service_sessions (worker_id, approval, session_date)` | DB-1, DB-5 **low** |
| 19 | **(Careful, tested) RLS per-row → set-membership rewrite** for `worker_companies`/`rates`/`documents` policies (match the efficient `company_id IN (SELECT unnest(my_admin_company_ids()))` form). Security-sensitive: `admin_can_see_worker` grants via *any* of a worker's companies — a naive rewrite narrows client-admin visibility. | DB-6 **low** |

### Phase 6 — Pure hygiene · S effort · trivial (not load-time)

- Remove dead deps: `date-fns`, `clsx`, `class-variance-authority`, `tailwind-merge` (zero imports in `src/`); delete orphaned `AddContractorModal.tsx`. (CB-5 / CFG-6)
- Delete `public/brand/logo-full.png` (2.1MB, unreferenced); re-export `logo.png` smaller. (RC-5)
- Split portal-only weather/skyline CSS (`globals.css` ~lines 2624–2894) out of the global stylesheet; either wire Tailwind v4 properly or remove the unused toolchain. (RC-4)
- `poweredByHeader: false` in `next.config.ts`. (CFG-2)

---

## Explicitly de-scoped / debunked (do NOT re-raise)

The adversarial pass dropped or corrected these — re-investigating them is wasted effort:

- **`experimental.ppr`** — **throws** a `HardDeprecatedConfigError` in Next 16.2.9. Use `cacheComponents` (Phase 4 #15) if pursuing PPR.
- **AUTH-6 (proxy "Set-Cookie churn on every prefetch")** — *false premise*. `getUser` only refreshes in the last ~90s of the 1h token (~2.5% of requests), and `@supabase/ssr` only writes cookies on an actual token refresh. Not a real issue.
- **DB-4 ("overview re-scans `time_entries` unindexed 4–5×")** — *miscounted + wrong index claim*. Only 3 overlapping period reads, all served by the existing `(company_id, work_date)` index; queries run in parallel. Minor redundant fan-out at most.
- **SW-6 (contractors `listCompanies` hoist)** — no win; `getSelectedCompanyId` already warms the `cache()` before the batch runs.
- **DB-5 / DB-7 as *load-time* items** — these run only inside the manual "Recalculate period" server action, never on a page render. The index (DB-5) is still fine hygiene; the latency claim is out of scope.
- **Dead deps / dead CSS / oversized images (CB-5, RC-4, RC-5, CFG-6)** — real cleanup, but **zero** runtime/navigation cost (unimported = tree-shaken; CSS cached after first load; `next/image` re-encodes on demand). Hygiene tier only.
- **DB indexes in general are NOT the cause of the felt lag** at current scale.

---

## How to measure (do this before & after each phase)

1. **Production build, not dev** — `pnpm build && pnpm start`. `next dev` recompiles each route on first visit and disables `<Link>` prefetch; its timings are not representative.
2. **Separate cold load from soft nav** — DevTools Network: hard-load `/overview` (measures proxy + layout + page auth/data) vs. click between sibling admin routes (the shared layout stays mounted — measures only the page segment + the proxy/prefetch tax).
3. **Per-route first-load JS** — parse each route's `__RSC_MANIFEST` in `.next/server/app/**/page_client-reference-manifest.js` and sum referenced chunk sizes (the CB investigation used this; current baselines: `/contractors` 661KB, `/onboarding` 656KB, `/portal/sessions` 620KB vs `/login` 312KB, all raw/uncompressed).
4. **Auth round-trip count** — log/trace `getUser` calls per navigation; target is 1 (render only) after Phase 3, 0-network after Phase 3 #12.
5. **Server timing** — Supabase Auth `/user` latency and per-query timing dominate; confirm the region RTT (deploy region is `sin1`).
