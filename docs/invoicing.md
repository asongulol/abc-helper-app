---
title: Invoicing
sidebar_position: 6
---

# Invoicing

Invoicing bills **client** companies for contractor work, in **USD**. It runs off the same
employer time as payroll but is otherwise independent — it does not touch PHP payouts. This is
stage 4 of the [Pay pipeline](./pay-pipeline.md).

## Employer vs. client

- The **employer** company (`companies.kind = 'employer'`) owns all `time_entries`. On the
  invoicing path it's resolved purely by `fetchEmployerCompanyId()` (`src/db/queries/invoicing.ts`)
  from `companies.kind = 'employer'` — no env override. (The `EMPLOYER_COMPANY_ID` override lives
  in `getEmployerCompanyId()` in `src/server/company.ts`, used by the Hubstaff-sync path, not here.)
- **Client** companies (`companies.kind = 'client'`, `status = 'active'`) are who you invoice.
  `fetchActiveClients()` lists them for the picker.
- Per-client billing rates live on the `worker_companies` link: **`bill_rate_usd`** (hourly) and
  **`session_rate_usd`** (per session). Null/0 produces a $0 line that's flagged to the admin, not
  dropped.

## The compute engine

`computeInvoice(roster, time, sessions, markupPct)` (`src/lib/invoicing/compute.ts`) is pure and
works in **integer USD cents** (ADR-0006). It produces two line kinds:

| Kind | Quantity | Rate | Source |
|---|---|---|---|
| **hourly** | worked hours (`tracked_seconds / 3600`, 2 dp) | `bill_rate_usd` | employer time, **PTO excluded** |
| **session** | approved session units (summed) | `session_rate_usd` | client `service_sessions`, `approval = 'approved'` |

- Worked hours are rounded to 2 dp **before** multiplying (matching the persisted
  `invoice_lines.worked_hours`). Session counts are whole units.
- Session billing is **roster-independent**: an approved session bills even if the worker's link
  is later deactivated/ended (the rate is resolved from the link at any status).
- **Markup is applied once** to the combined subtotal — never per-line. `total = subtotal × (1 +
  markupPct/100)`.

Hourly hours come from `fetchEmployerTrackedSeconds()` (employer-scoped, PTO already excluded);
sessions from `fetchClientSessions()` (client-scoped, approved only).

## Actions

All in `src/server/actions/invoicing.ts`, admin-gated (owner, or the client must be in the
admin's company scope). Inputs are Zod-validated `{ clientId, from, to, markupPct }`.

- **`previewInvoice()`** — recomputes from source and returns the lines + totals **without
  persisting**; safe to call repeatedly. Flags contractors with `$0` bill/session rates
  (`zeroRateNames`, `zeroSessionRateNames`).
- **`generateInvoice()`** — recomputes fresh, rejects if there are no billable lines, allocates an
  invoice number, and inserts the header + lines atomically. Returns the `invoiceNo`.
- **`setInvoiceStatus()`** — `draft` / `sent` / `void` (status only; `paid` is rejected by the
  action's own guard — not the input schema — so use `markInvoicePaid` instead).
- **`markInvoicePaid()`** — sets `status = 'paid'` and records the AR receipt
  (`amount_received_usd`, `received_on`, `payment_ref`).

### Invoice numbers & uniqueness

`allocateInvoiceNo()` calls the DB function `allocate_invoice_no()` → a year-scoped sequence
`YYYY-NNNN` (e.g. `2026-0007`), serialized by an advisory lock and never reused after a void.
A unique constraint enforces **one non-void invoice per (client, period)**;
`createInvoiceWithLines()` surfaces a friendly error if you'd violate it (void the old one first).

## Data model

`invoices`: `company_id` (client), `period_start/end`, `invoice_no`, `status`
(`draft|sent|paid|void`), `subtotal_usd`, `total_usd`, `markup_pct`, `currency` (`USD`), plus AR
columns `amount_received_usd`, `received_on`, `payment_ref`.

`invoice_lines` (a snapshot at generation time — rates are never re-fetched): `worker_name`,
`position`, `kind` (`hourly|session`), `worked_hours`, `bill_rate_usd`, `sessions_count`,
`session_rate_usd`, `amount_usd`.

> **AR scope:** client-invoice AR (`amount_received_usd` etc.) is manual per-invoice tracking via
> `markInvoicePaid`. It is **not** the same as contractor-payout reconciliation
> (`src/server/actions/reconcile.ts`), which operates on the `payments` table — see
> [Wise payouts](./wise.md).

## Print view

`src/app/(admin)/invoicing/[id]/print/page.tsx` renders a printable invoice: employer → client
header, invoice no / period / status, the line table (Contractor · Position · Type · Qty · Unit
rate · Amount), subtotal + markup (when > 0), and the total. It auto-opens the print dialog and
footnotes that PTO is not billed.
