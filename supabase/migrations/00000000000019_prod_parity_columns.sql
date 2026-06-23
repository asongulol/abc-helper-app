-- Local-dev parity with the shared prod DB (cgsidolrauzsowqlllsz).
-- ---------------------------------------------------------------------------
-- abc-helper-app REPLACES the original apps and runs on their shared prod DB.
-- Prod already carries the objects below; the squashed repo baseline did not.
-- This migration adds them to a from-scratch local/CI DB so `supabase db reset`
-- reproduces prod's actual schema. It is ADDITIVE and IDEMPOTENT.
--
-- ⚠️ DO NOT push this (or any repo migration) to the shared prod — prod already
-- has these and its migration history is disjoint from the repo's. Prod-side
-- additive changes are staged separately and applied via the Dashboard SQL
-- Editor after grepping all sibling apps. See docs/PROD-CONFORMANCE-PLAN.md.
-- ---------------------------------------------------------------------------

-- NOTE on 'PHS': prod's contract_type enum also carries 'PHS' (the originals'
-- *current* per-hour/session model: contract='PHS' + worker_companies.pay_basis
-- ∈ {hourly, per_session}). abc-helper-app still uses separate 'PH'/'PS' and does
-- NOT yet read pay_basis, so it cannot pay a PHS worker correctly (calc would
-- treat them as salaried → overpayment). 'PHS' is therefore intentionally NOT
-- added here; it lands together with the calc/mapper handling in the dedicated
-- "contract-model conformance" PR. See docs/PROD-CONFORMANCE-PLAN.md §C.

-- payments: prod's funding-workflow + pay-basis columns (all nullable, app does
-- not yet read them; present so local rows round-trip identically to prod).
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "contract" text;
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "pay_basis" text;
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "units" numeric(12,2);
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "funded_at" timestamp with time zone;
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "funded_by" text;
ALTER TABLE "public"."payments" ADD COLUMN IF NOT EXISTS "fund_error" text;

-- worker_companies.pay_basis (prod).
ALTER TABLE "public"."worker_companies" ADD COLUMN IF NOT EXISTS "pay_basis" text;

-- companies.api_payouts_enabled (prod).
ALTER TABLE "public"."companies" ADD COLUMN IF NOT EXISTS "api_payouts_enabled" boolean NOT NULL DEFAULT false;

-- documents.defer_until (prod).
ALTER TABLE "public"."documents" ADD COLUMN IF NOT EXISTS "defer_until" date;

-- Partial index prod uses to find unfunded, wise-initiated draft payouts.
CREATE INDEX IF NOT EXISTS "payments_unfunded_drafts"
  ON "public"."payments" USING btree ("pay_period_id")
  WHERE (("wise_transfer_id" IS NOT NULL) AND ("funded_at" IS NULL) AND ("status" <> 'reconciled'::"public"."payment_status"));
