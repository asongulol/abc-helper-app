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

-- contract_type gains 'PHS' (the originals' current per-hour/session model:
-- contract='PHS' + worker_companies.pay_basis ∈ {hourly, per_session}). The
-- payroll engine now reads pay_basis and pays PHS correctly (per_hour ≡ legacy
-- PH, per_session ≡ legacy PS; an unset pay_basis is paid NOTHING, never guessed).
ALTER TYPE "public"."contract_type" ADD VALUE IF NOT EXISTS 'PHS';

-- payments: prod's funding-workflow + pay-basis columns (all nullable). The
-- payroll engine WRITES contract, pay_basis, and units (session count for
-- per_session rows) onto each payment for parity with the originals; the
-- funding columns (funded_at/funded_by/fund_error) stay app-unwritten (the
-- original apps own the Wise funding workflow).
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
