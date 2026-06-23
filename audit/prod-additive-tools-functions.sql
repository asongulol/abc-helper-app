-- ============================================================================
-- abc-helper-app → shared prod: ADDITIVE tools function (apply MANUALLY)
-- ============================================================================
-- Target project: cgsidolrauzsowqlllsz  ("ABC HR-Payroll App")
--
-- Second, smaller additive step (the first was prod-additive-conformance.sql).
-- Apply the same way: Dashboard → SQL Editor → Run the whole file. Idempotent.
--
-- STATUS: APPLIED + VERIFIED on prod 2026-06-23 (my_tools_pending() now present;
-- before this, prod lacked it per the 2026-06-22 db diff). Re-running is a no-op.
--
-- WHAT THIS ADDS: my_tools_pending() — a read-only, self-scoped boolean the
-- contractor portal calls to decide whether to show the "tools provisioned"
-- popup, WITHOUT decrypting the credentials. The original apps don't have or
-- call it (they read popup_pending off get_my_tools/get_tools_status), so this
-- is purely additive — verified 2026-06-23 by grepping all three live apps (0
-- references). Rollback: DROP FUNCTION public.my_tools_pending();
--
-- WHY ONLY THIS ONE: abc-helper-app's admin tool-reveal now calls prod's
-- existing PERSISTENT `decrypt_worker_tools(uuid)` (no purge), which prod already
-- has — so no other prod function is needed or changed. abc-helper-app
-- deliberately does NOT deploy its old one-time-purge get_my_tools /
-- reveal_worker_tools to prod: nulling worker_tools.enc would delete credentials
-- the live apps still re-read. The shared model is persistent, period.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.my_tools_pending()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
  select coalesce(
    (select popup_pending from public.worker_tools where worker_id = public.my_worker_id()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.my_tools_pending() FROM public;
GRANT EXECUTE ON FUNCTION public.my_tools_pending() TO authenticated, service_role;

COMMIT;

-- ── Verify (optional; run after COMMIT) ─────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE proname = 'my_tools_pending';  -- expect one row
