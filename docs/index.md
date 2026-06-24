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

## Runbooks & deploy

- [Cutover runbook](./CUTOVER-RUNBOOK.md)
- [Cutover verification](./CUTOVER-VERIFICATION.md)
- [Deploy](./DEPLOY.md)

## Specs & conformance

- [Prod conformance plan](./PROD-CONFORMANCE-PLAN.md)
- [Money core spec](./money-core-spec.md)
- [Recreation handoff](./RECREATION-HANDOFF.md)
- [Recreation recommendations](./RECREATION-RECOMMENDATIONS.md)
