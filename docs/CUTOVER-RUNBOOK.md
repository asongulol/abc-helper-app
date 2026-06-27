# Cutover runbook

The exact sequence to move production from the old app to `abc-helper-app`, plus
the result of the dry run that validated it. Pair with `docs/DEPLOY.md` (env) and
`docs/CUTOVER-VERIFICATION.md` (parity gate).

## Dry-run result (LOCAL stack, 2026-06-13)

A full payroll cycle was run end-to-end through the new engine against the local
Supabase stack, then verified by the cutover gate. **Every step passed.**

| Step | Tool | Result |
|------|------|--------|
| 1. Run a payroll cycle (calculate → lock → mark paid) | `scripts/cutover-cycle.mjs` | 3 paid statements produced; prorated math correct (80/88 × ₱25,000 = ₱22,727.27, etc.) |
| 2. Cutover gate | `pnpm parity:verify` | **3/3 rows reproduce to the centavo · exit 0** |
| 3. Additive-migration check | repo + prod catalog diff | new app ships **only the baseline migration**; references **only tables that already exist in prod** (0 missing) → cutover is "point at prod," not a schema change; old app stays a valid rollback |
| 4. Build / CI | GitHub Actions | green (lint, typecheck, guardrails, 257 tests, build) |

Two harmless cleanups were found and fixed during the dry run (a REST helper
that mis-parsed empty PostgREST bodies; a dead import in the cycle script). No
issues in the app itself.

## Pre-flight (any time before cutover)

- [ ] CI green on `main`.
- [ ] Vercel env set (see `docs/DEPLOY.md`): real prod Supabase URL + anon +
      service key; `WISE_API_TOKEN`/`WISE_PROFILE_ID`; `HUBSTAFF_REFRESH_TOKEN`;
      `CRON_SECRET`; `GMAIL_USER`/`GMAIL_APP_PASSWORD`; `APP_URL` = public URL.
- [ ] An owner `admin_users` row exists in prod for whoever will sign in
      (prod already has the real admins; no seeding needed).

## Cutover (between pay periods — pick a window with no open period)

1. **Freeze writes on the old app.** Easiest: set the old Cloudflare app to a
   read-only/maintenance state, or just announce a freeze and stop using it.
   There must be no in-flight open/locked (unpaid) period mid-edit.
2. **Apply any schema changes to prod — additive only, via the Dashboard SQL
   Editor. NEVER `supabase db push` / the migration CLI.** abc-helper's migrations
   are local-only and have *zero overlap* with prod's migration history, so a CLI
   push would try to re-run the whole baseline on the live shared DB. Any change
   must be backward-compatible (the still-live legacy apps keep reading the DB) and
   sibling-grep-verified first. The conformance objects (`coverage_targets`,
   invoices AR cols, `worker_tools.revealed_at`, `my_tools_pending`) were applied
   exactly this way. See `audit/CUTOVER-PLAN-2026-06-24.md` §2.
3. **Run the gate against prod (read-only):**
   ```sh
   pnpm parity:verify --url https://cgsidolrauzsowqlllsz.supabase.co --key <PROD_SERVICE_KEY>
   ```
   Must print `exit 0` and show every checkable row matching. If it exits
   non-zero, STOP and investigate the listed rows before proceeding.
4. **Point the new app at prod + deploy:** set the prod env in Vercel, trigger a
   deploy, confirm the build is green and the app loads + you can sign in.
5. **Flip the URL.** Move `payroll.abbilabs.com` (or the chosen domain) to the
   Vercel deployment. (DNS/though Cloudflare → Vercel.)
6. **Smoke test on prod:** sign in, open the most recent paid period (read-only),
   confirm Overview tiles + a contractor's statement look right. Do NOT
   recalculate a paid period.

## First live period on the new app

- Import/approve time as usual → Calculate → review the draft table → Lock →
  draft Wise transfers (OWNER) → **fund manually in the Wise UI** → run
  `wisePoll` / "Check statuses" to reconcile → Mark paid.
- Compare that period's totals against what the old app would have produced for
  the same inputs (the parity gate already guarantees the formula; this is the
  human gut-check).

## Rollback

Because cutover changes no schema and moves no data, rollback is just **flip the
URL back to the old Cloudflare app.** Keep the old app deployed until at least
one full pay period has run clean on the new app. If a new additive migration
was applied, it stays (the old app ignores new columns/tables).

## Money safety (always)

The new app NEVER funds Wise transfers — it drafts them; the owner funds in the
Wise UI. The guardrails scanner enforces this in CI. Cutover does not change
this.
1