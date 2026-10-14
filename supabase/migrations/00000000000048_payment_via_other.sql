-- ---------------------------------------------------------------------------
-- Pay list: the admin can change how a row is paid, before and after sending.
-- Options are Wise / BPI / Other (specify) — 'other' joins the enum and the
-- specified text lives beside it. Both are operational columns: editable in
-- any period state (payments_period_open_enforce leaves them alone); the Wise
-- row-lock trigger still freezes payout_method once wise_locked_at is set.
-- ADD VALUE is idempotent and must not be used in the txn that adds it.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."payout_method" ADD VALUE IF NOT EXISTS 'other';

ALTER TABLE "public"."payments"
  ADD COLUMN IF NOT EXISTS "payout_method_other" text;

COMMENT ON COLUMN "public"."payments"."payout_method_other" IS
  'Free text naming the channel when payout_method = other (e.g. "cash", "GCash via Maria"). Null otherwise.';
