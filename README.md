# abc-helper-app

Parallel rewrite of the ABC payroll app (`abc-work-app-payroll-wis-hubstaff-app`) onto the
NPM-Helper-App stack: **Next.js (App Router) · TypeScript strict · @supabase/ssr · Vitest ·
Biome · lefthook**. Built per `FABLE-HANDOFF-abc-migration.md` / `abc-migration-plan.md`.

**The live app stays untouched until cutover.** This repo targets a separate **dev** Supabase
project; cutover later just points it at prod (migrations stay additive so the old app remains
the rollback).

## Status

- [x] Phase 0 — scaffold (tooling copied from NPM-Helper-App)
- [x] Phase 1 — money core: `src/lib/{money,dates,pay}` ported pure + typed, unit/differential
      tests vs the legacy formulas; parity fixtures from real periods in `tests/lib/pay/parity*`
- [x] Phase 2 — auth + data layer (`@supabase/ssr`, `src/db/`, Zod at boundaries)
- [x] Phase 3 — full admin screens + contractor portal + Wise module + dev seed
- [x] Phase 4 — shared Hubstaff + documents cron logic (cron/webhook fns stay Deno)
- [x] Phase 5 — parallel parity-verification harness (`pnpm parity:verify`, cutover gate)
- [ ] Phase 6 — cutover between pay periods (dry-run passed 2026-06-13; see `docs/CUTOVER-RUNBOOK.md`)

## Money rules (non-negotiable)

- Integer **centavos** via branded types (`src/lib/money`) — never floats (ADR-0006).
- Wise is **DRAFT-ONLY**: no funding endpoint may ever be called (ADR-0007; enforced by
  `scripts/guardrails.mjs` in pre-push + CI).
- Secrets server-side only; `NEXT_PUBLIC_*` secrets are blocked by guardrails.
- Parity first, features later: match the old app before adding anything.

## Commands

```sh
pnpm install      # also installs lefthook hooks
pnpm dev          # Next dev server
pnpm test         # Vitest (tests/ mirrors src/)
pnpm typecheck    # tsc --noEmit
pnpm check        # Biome lint+format
pnpm guardrails   # security gate
```

## Key docs

- `docs/money-core-spec.md` — the ported payroll math, line-anchored to the legacy app
- Reference ADRs live in `NPM-Helper-App/docs/adr/` (0002–0007, 0012, 0016, 0017, 0020, 0027, 0028)
