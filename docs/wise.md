---
title: Wise payouts (draft-only)
sidebar_position: 7
---

# Wise payouts (draft-only)

The app pays contractors in PHP through Wise — but **it never moves money**. It prepares quotes,
recipients, and **draft** transfers; the owner reviews and funds them in the Wise UI. This is
stage 5 of the [Pay pipeline](./pay-pipeline.md).

## The invariant (ADR-0007)

> Money movement is **draft-only**. No funding endpoint may exist anywhere in the codebase.

This is documented in headers across `src/server/wise/client.ts`, `src/server/actions/wise.ts`,
and the `wise-payouts` edge function — and, crucially, **enforced at build time**.
`scripts/guardrails.mjs` scans both `src/` and `supabase/functions/` and fails the build on:

```js
/\bfundTransfer\b|\bfundWithBalance\b|\.fund\s*\(|\/transfers\/[^'"`\n]*\/payments\b/
```

That blocks `fundTransfer`/`fundWithBalance`, any `.fund(` call, and the Wise funding endpoint
path `/transfers/{id}/payments`. The guardrail runs in pre-push and CI. The Wise client
(`src/server/wise/client.ts`) is *intentionally* missing any funding helper.

## Actions

In `src/server/actions/wise.ts`. The two that create drafts are **owner-only**; the rest are
admin-only and read-only against Wise.

| Action | Auth | What it does |
|---|---|---|
| `wiseDraft(paymentIds)` | owner | Per payment: quote → draft transfer → write `wise_transfer_id` + `fx_rate`. **Never funds.** |
| `wiseBatch(paymentIds, name?)` | owner | Same, inside a Wise **batch group**; owner completes + funds the group in the UI. |
| `wisePoll()` | admin | Reconcile: re-fetch transfer status, flip `draft → sent` on terminal states. Idempotent. |
| `wiseMatch(args)` | admin | Backfill: match payments missing a transfer id against Wise history by recipient + amount + date. |
| `wiseStatus(paymentIds)` | admin | Look up current status per payment. |
| `wiseRecipients()` / `wiseGetRecipient(id)` | admin | List / fetch saved recipients. |
| `wisePullRecipientIds()` | admin | Read-only: match Wise recipients to workers by name, write numeric `wise_recipient_id`. No bank details, no money. |
| `wiseFindTransfersByRecipient(id)` | admin | Query transfer history (±90d) for a recipient. |

## The draft flow

`serviceDraft()` (`src/server/wise/service.ts`), per payment:

1. Resolve the worker's `wise_recipient_id` (skip if missing).
2. Create a quote: `POST /v3/profiles/{profileId}/quotes` (`PHP → PHP`, `payOut: BALANCE`) →
   `quote.id`, `quote.rate`.
3. Create a **draft** transfer: `POST /v1/transfers` (`targetAccount`, `quoteUuid`) →
   `transfer.id`.
4. **Stop.** No `POST …/payments`. Money has not moved.
5. Write `wise_transfer_id` + `fx_rate` back to the payment.

The business profile id is fetched once (`GET /v2/profiles`) and memoized at module scope.
`serviceBatch()` does the same inside a batch group and deliberately does **not** complete or
fund it.

## Reconcile & match

- **Poll** (`servicePoll()`): fetch payments with a `wise_transfer_id` (drafts by default),
  `GET /v1/transfers/{id}` for each (bounded concurrency), and classify by status. Terminal
  success states (`WISE_PAID_STATES` in `src/lib/wise/types.ts`) → `markPaymentSent()`: status
  `sent`, real `paid_at` from Wise, the `wise_dates` triple, and `wise_locked_at = now`.
  In-flight states are surfaced but not changed.
- **Match** (`serviceMatch()`): for payments that never got a transfer id, pull Wise history over
  the union date window and match by recipient + amount (±₱1.00) + time window. The pure matching
  rules live in `src/lib/wise/matcher.ts` (`decideMatch` / `decideRefresh`, recipient indexing,
  cancelled-"ghost"-transfer filtering) — ported faithfully from the legacy edge function with its
  incident comments preserved.

`src/lib/wise/dates.ts` normalizes Wise timestamps (`toIsoWise`, `bestSentDate`).

## Payment lifecycle (Wise columns)

```
draft   from Calculate (see Pay pipeline)
draft   wiseDraft / wiseBatch: write wise_transfer_id + fx_rate  (status UNCHANGED)
sent    wisePoll / wiseMatch: terminal Wise status → status=sent, paid_at, wise_dates, wise_locked_at
```

A payment is born `draft`; `wiseDraft`/`wiseBatch` only annotate it (`wise_transfer_id`,
`fx_rate`) — they do **not** change `status`. Only the reconcile step flips `draft → sent`.
(`open`/`paid` are *pay-period* states, not payment statuses — see [Pay pipeline](./pay-pipeline.md).)

Relevant `payments` columns: `wise_transfer_id`, `fx_rate`, `wise_dates` (jsonb
`{created, dateFunded, dateSent}`), `wise_locked_at` (once set, locks payout fields), `paid_at`,
`status`. The payment *rows* themselves are produced by [Calculate](./pay-pipeline.md); Wise only
annotates them.

## Scheduled reconcile

Beyond the in-app `wisePoll`, the Supabase **`wise-payouts`** Deno edge function runs the same
reconcile on a schedule. It's gated by `x-cron-secret` (`verify_jwt = false`) and, by
construction, only `GET`s transfer detail and `PATCH`es payment status — there is no funding call
(the guardrail scans this directory too). Its date helpers are vendored from `src/lib/wise/dates.ts`.
