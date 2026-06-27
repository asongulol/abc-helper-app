---
slug: /
title: ABC Helper Docs
sidebar_position: 0
---

# ABC Helper Documentation

Payroll pipeline — contractor onboarding → Hubstaff time tracking → pay calculation →
invoicing → Wise payments — plus the self-serve contractor portal.

## Start here

- [Architecture overview](./architecture.md) — the two surfaces, the request lifecycle, where code lives
- [Local development](./local-development.md) — clone → running app + admin & portal logins
- [Pay pipeline](./pay-pipeline.md) — onboarding → time → pay → invoicing → Wise, end to end

## Domain guides

- [Onboarding & documents](./onboarding-documents.md) — the 3-stage wizard, agreements/countersign, doc review, reminder digests
- [Hubstaff integration](./hubstaff.md) — time sync, matching, approval
- [Invoicing](./invoicing.md) — client billing in USD
- [Wise payouts (draft-only)](./wise.md) — PHP payouts; the no-funding invariant
- [Coverage & reports](./coverage-reports.md) — expected vs. actual hours, pay reports, the overview dashboard
- [Contractor portal](./portal.md) — the self-serve surface, auth, profile self-service

## Data & operations

- [Data model](./data-model.md) — the schema, by group, with RLS and money-column notes
- [Shared-prod conformance](./shared-prod-conformance.md) — the additive-only rules for the shared production DB
- [Cron & secrets](./cron-and-secrets.md) — the scheduled jobs and where every secret lives
- [Security & guardrails](./security.md) — the build-time guardrails, money invariants, PHI encryption

The **Reference** tab (top nav) holds the generated [Server actions](pathname:///reference/server-actions),
API, and code references.

## Runbooks & deploy

- [Cutover runbook](./CUTOVER-RUNBOOK.md)
- [Cutover verification](./CUTOVER-VERIFICATION.md)
- [Deploy](./DEPLOY.md)

## Specs & conformance

- [Prod conformance plan](./PROD-CONFORMANCE-PLAN.md)
- [Money core spec](./money-core-spec.md)
- [Recreation handoff](./RECREATION-HANDOFF.md)
- [Recreation recommendations](./RECREATION-RECOMMENDATIONS.md)
