-- ============================================================================
-- Additive performance indexes for the SHARED PROD DB (cgsidolrauzsowqlllsz).
-- Source: audit/LOADTIME-PLAN-2026-06-26.md, findings DB-1/2/3/5.
-- Mirror of repo migration supabase/migrations/00000000000021_perf_indexes.sql
-- (same index names); this is the PROD-APPLY copy.
-- ============================================================================
--
-- WHY THIS IS SAFE ON THE SHARED DB (3 sibling apps still live):
--   Indexes are TRANSPARENT — they only speed up matching queries and NEVER
--   change query results, so they cannot break the originals. Nothing is
--   renamed/dropped/altered. Every statement is CREATE INDEX IF NOT EXISTS, so
--   re-running is a no-op. (Conforms to docs/PROD-CONFORMANCE-PLAN.md: additive-
--   only on prod.)
--
-- HOW TO APPLY (Dashboard SQL Editor or psql — NOT the migration CLI):
--   * Run ONE statement at a time.
--   * CONCURRENTLY builds each index WITHOUT a write lock on the live table, so
--     the sibling apps keep reading/writing during the build. CONCURRENTLY
--     CANNOT run inside a transaction — do NOT wrap these in BEGIN/COMMIT, and
--     if the SQL Editor auto-wraps, paste/run each line individually.
--   * time_entries is the largest table — expect its build to take the longest.
--   * If a CONCURRENTLY build is interrupted it can leave an INVALID index; in
--     that case run `DROP INDEX CONCURRENTLY IF EXISTS <name>;` then re-run.
--
-- VERIFY AFTER (each should show valid = true):
--   SELECT indexrelid::regclass AS index, indisvalid AS valid
--   FROM pg_index WHERE indexrelid::regclass::text IN (
--     'documents_company_created_idx','time_entries_company_approval_date_idx',
--     'rates_company_id_idx','service_sessions_worker_approval_date_idx');
-- ============================================================================

-- DB-2: /documents + /overview docs scan (WHERE company_id ORDER BY created_at DESC).
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_company_created_idx
  ON public.documents (company_id, created_at DESC);

-- DB-3: approval-filtered time reads + the unbounded countPendingTimeApprovals
-- (overview tile + /process) — the (company_id, approval) prefix makes it index-only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_company_approval_date_idx
  ON public.time_entries (company_id, approval, work_date);

-- DB-1: rates company-scoped reads (fetchRates, getAlerts) — existing index leads
-- with worker_id, so company-only predicates seq-scan today.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rates_company_id_idx
  ON public.rates (company_id, effective_start);

-- DB-5: per-session payroll reads (worker_id IN (...) + approval + session_date range).
CREATE INDEX CONCURRENTLY IF NOT EXISTS service_sessions_worker_approval_date_idx
  ON public.service_sessions (worker_id, approval, session_date);
