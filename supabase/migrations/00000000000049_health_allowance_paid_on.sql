-- ---------------------------------------------------------------------------
-- Health allowance paid early. The annual ₱20,000 pays in the anniversary
-- period, but the owner sometimes pays it ahead of time outside the run. This
-- date records when it was actually paid; the calc engine pays no HA in any
-- period of the same calendar year. Nullable, so the legacy portal (same DB)
-- is unaffected.
-- ---------------------------------------------------------------------------
ALTER TABLE "public"."workers"
  ADD COLUMN IF NOT EXISTS "health_allowance_paid_on" date;

COMMENT ON COLUMN "public"."workers"."health_allowance_paid_on" IS
  'When this year''s health allowance was actually paid, if paid outside its anniversary period. The engine skips HA for every period in that calendar year.';
