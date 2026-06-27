-- 0021 — additive performance indexes for hot read paths.
-- Source: audit/LOADTIME-PLAN-2026-06-26.md (findings DB-1/2/3/5), verified absent
-- from the existing index set. Index-only, additive, idempotent — NO schema or
-- behavior change, results are identical with or without these.
--
-- This transactional form is the LOCAL repo lineage only (repo migrations never
-- target the shared prod DB — see docs/PROD-CONFORMANCE-PLAN.md and
-- scripts/assert-local-supabase-target.mjs). The prod-apply version uses
-- CONCURRENTLY to avoid a write lock on the live tables:
-- audit/perf-indexes-2026-06-27.sql. Index NAMES match across both files.

BEGIN;

-- DB-2: /documents list + the overview docs scan — `WHERE company_id = $1
-- ORDER BY created_at DESC`. No existing index leads with company_id, so this
-- seq-scans + sorts the whole table today.
CREATE INDEX IF NOT EXISTS documents_company_created_idx
  ON public.documents (company_id, created_at DESC);

-- DB-3: approval-filtered time reads. No existing index includes `approval`. The
-- (company_id, approval) prefix turns the otherwise-unbounded
-- countPendingTimeApprovals (overview "Time pending approval" tile + /process)
-- into an index-only count; the full tuple serves the period approved/pending
-- range scans (fetchApprovedTime, getAlerts).
CREATE INDEX IF NOT EXISTS time_entries_company_approval_date_idx
  ON public.time_entries (company_id, approval, work_date);

-- DB-1: rates filtered by company_id alone (fetchRates on /payroll + /contractors,
-- getAlerts on /overview). The only existing index leads with worker_id, so a
-- company-only predicate cannot use it and seq-scans. The trailing effective_start
-- also serves getAlerts' `effective_start <= $period_end` bound.
CREATE INDEX IF NOT EXISTS rates_company_id_idx
  ON public.rates (company_id, effective_start);

-- DB-5: per-session payroll reads — `worker_id IN (...) AND approval = 'approved'
-- AND session_date BETWEEN $1 AND $2` (calculate-draft action). Existing
-- service_sessions_worker_idx covers only worker_id, leaving approval + date as
-- per-row filters.
CREATE INDEX IF NOT EXISTS service_sessions_worker_approval_date_idx
  ON public.service_sessions (worker_id, approval, session_date);

COMMIT;
