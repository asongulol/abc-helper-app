-- ---------------------------------------------------------------------------
-- 13th month paid early — the sibling of migration 49's HA date. The 13th
-- month accrues in the year-end run, but the owner sometimes pays it ahead of
-- time outside the run. This date records when it was actually paid; the calc
-- engine accrues none in any period of the same calendar year. Nullable, so
-- the legacy portal (same DB) is unaffected.
-- ---------------------------------------------------------------------------
ALTER TABLE "public"."workers"
  ADD COLUMN IF NOT EXISTS "thirteenth_month_paid_on" date;

COMMENT ON COLUMN "public"."workers"."thirteenth_month_paid_on" IS
  'When this year''s 13th month was actually paid, if paid outside the year-end run. The engine accrues no 13th month for any period in that calendar year.';
