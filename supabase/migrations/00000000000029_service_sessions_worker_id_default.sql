-- ============================================================================
-- Fix contractor self-insert of Early-Intervention sessions
-- ----------------------------------------------------------------------------
-- A contractor logging their own session under their JWT (client-side insert,
-- RLS enforced) always failed with "new row violates row-level security policy
-- for table service_sessions". Two independent causes:
--
-- 1) BROKEN POLICY (root cause). service_sessions_contractor_insert's WITH CHECK
--    ended in an EXISTS subquery that reads worker_companies + companies
--    DIRECTLY. Both tables are admin-only under RLS, so under the contractor
--    role that subquery sees ZERO rows and returns false — the check could never
--    pass for a real contractor JWT. It went unnoticed because the app's portal
--    action inserts via the SERVICE ROLE (bypasses RLS); only a client-side
--    authenticated insert hits the policy. Fix: replace the raw EXISTS with
--    `company_id IN (SELECT id FROM my_clients())`. my_clients() is
--    SECURITY DEFINER (reads the admin-only tables as its owner) and returns the
--    same set — active worker_companies links where companies.kind='client' and
--    the company is active — which is exactly what the sibling contractor_update
--    policy already uses. Same security intent, now actually satisfiable.
--
-- 2) MISSING worker_id (secondary). The check also requires
--    `worker_id = my_worker_id()`. A minimal form that omits worker_id stored
--    NULL and failed that conjunct too. Default worker_id to my_worker_id() so an
--    omitted value resolves to the submitting contractor. Paths that pass
--    worker_id explicitly (admin entry, CSV import, service-role portal action)
--    are untouched — a column default only fires when the column is absent, and
--    my_worker_id() is NULL in an admin/service context anyway.
--
-- ⚠️ Local/CI only — prod copy hand-applied via MCP (disjoint history).
-- Security-preserving (same membership semantics) + idempotent (ALTER re-applies
-- the same expression; SET DEFAULT is a no-op if re-run).
--
-- my_clients() is defined here too: it was hand-applied to prod (MCP) and
-- captured only in audit/repo-to-prod-schema-diff-2026-06-22.sql, never in a
-- migration — so a from-scratch `db reset`/`db push` failed at this file with
-- "function my_clients() does not exist" for every environment since this
-- migration merged. Defining it (verbatim from that prod snapshot; idempotent
-- CREATE OR REPLACE) before the policy that uses it makes this migration
-- self-contained and restores a clean reset. Depends only on my_worker_id() +
-- base tables, both already present at this point in the history.
-- ============================================================================

create or replace function public.my_clients()
  returns table(id uuid, name text)
  language sql
  stable security definer
  set search_path to 'public'
as $function$
  select c.id, c.name
  from worker_companies wc
  join companies c on c.id = wc.company_id
  where wc.worker_id = public.my_worker_id()
    and wc.status = 'active'
    and c.kind = 'client'
    and c.status = 'active'
  order by c.name;
$function$;

alter policy service_sessions_contractor_insert on public.service_sessions
  with check (
    worker_id = my_worker_id()
    and approval = 'pending'::approval_status
    and approved_by is null
    and (select is_onboarded())
    and company_id in (select id from my_clients())
  );

alter table public.service_sessions
  alter column worker_id set default my_worker_id();

-- ROLLBACK:
--   alter table public.service_sessions alter column worker_id drop default;
--   -- restore the pre-fix (broken) EXISTS check if ever needed:
--   alter policy service_sessions_contractor_insert on public.service_sessions
--     with check (
--       worker_id = my_worker_id() and approval = 'pending'::approval_status
--       and approved_by is null and (select is_onboarded())
--       and exists (
--         select 1 from worker_companies wc join companies c on c.id = wc.company_id
--         where wc.worker_id = my_worker_id() and wc.company_id = service_sessions.company_id
--           and wc.status = 'active' and c.kind = 'client'));
