-- Contract backpay: extend the off_cycle_pay_items basis CHECK with 'backpay' —
-- the difference owed on periods already PAID at the old rate when a contract
-- version takes effect earlier than the day it was countersigned (late reviews;
-- docs/CONTRACT-VERSIONS-PLAN.md slice 4b, owner decisions 2026-09-04).
--
-- Row shape for the new basis: session_id null, work_date = the ORIGINAL paid
-- period's period_start (so the existing off_cycle_manual_date_uniq partial
-- unique index dedups one backpay per worker per original period, and never
-- collides with a salaried catch-up on the same period, which is keyed on
-- period_end), units null, rate_php = the new contract rate, amount_php =
-- Σ paid × (new − old) / old × (working days on/after the effective date ÷
-- working days in the period) over the period's payment row and any catch-up
-- rows priced at the old rate — a snapshot, never re-priced, like every other
-- ledger row.
--
-- Deliberately NOT feeding perHourDatesByWorker (per_hour-only), same as
-- salaried_hours: an unlock + recalc of the original period is not corrupted.
--
-- ADDITIVE + IDEMPOTENT. Do NOT `db push` to shared prod — apply via the SQL
-- Editor / MCP, then record "00000000000045" in supabase/prod-applied.json.

alter table public.off_cycle_pay_items
  drop constraint if exists off_cycle_pay_items_basis_check;
alter table public.off_cycle_pay_items
  add constraint off_cycle_pay_items_basis_check
  check (basis in ('per_session', 'per_hour', 'salaried_hours', 'backpay'));

-- ROLLBACK: delete rows with basis='backpay', then re-add the three-value
-- check ('per_session', 'per_hour', 'salaried_hours').
