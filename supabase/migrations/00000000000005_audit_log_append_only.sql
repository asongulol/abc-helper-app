-- F-2 — Enforce audit_log append-only at the database level (Appendix C: the live
-- policy is `for all`, so a scoped admin could in principle UPDATE/DELETE their
-- company's trail). A BEFORE UPDATE/DELETE/TRUNCATE trigger blocks those paths for
-- the application role. INSERT/SELECT are unaffected, so logEvent() still works and
-- the AuditLog screen still reads.
--
-- Safe: nothing in the app UPDATEs/DELETEs audit_log (only logEvent inserts), and a
-- company delete preserves the trail via the existing FK (company_id ON DELETE SET
-- NULL) — not an audit_log DELETE. A superuser/service-role DDL can always drop the
-- trigger; this enforces against the app, which is the documented gap. Additive.

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_log_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
begin
  raise exception 'audit_log is append-only (% blocked)', TG_OP
    using errcode = 'check_violation',
          hint = 'Audit rows are immutable; insert a new row instead.';
end
$$;

DROP TRIGGER IF EXISTS audit_log_no_mutate ON public.audit_log;
CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

COMMIT;
