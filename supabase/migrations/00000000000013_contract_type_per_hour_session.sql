-- ============================================================================
-- Per-hour / per-session contract types
-- ----------------------------------------------------------------------------
-- Two new contract_type values for providers who are NOT salaried FT/PT:
--   PH = per hour    — paid worked hours × a per-HOUR rate
--   PS = per session — paid number of sessions × a per-SESSION rate
-- Neither has an expected number of hours, so the expected-hours / performance-
-- ratio pay model does not apply (see src/lib/pay/expected-hours.ts &
-- src/lib/pay/calc.ts). PS ties to the per-session billing setup.
--
-- ADD VALUE is idempotent (IF NOT EXISTS) and must run outside a txn that uses
-- the value; this migration only adds them.
-- ============================================================================

alter type public.contract_type add value if not exists 'PH';
alter type public.contract_type add value if not exists 'PS';

-- ROLLBACK: Postgres has no DROP VALUE for enums; removing requires recreating
-- the type. Left intentionally non-reversible (additive enum values are safe).
