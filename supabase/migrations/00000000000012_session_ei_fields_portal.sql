-- ============================================================================
-- Early-Intervention session fields + contractor (portal) access
-- ----------------------------------------------------------------------------
-- Contractors record per-session detail from the portal: a child's initials and
-- the EIID (Early-Intervention ID), alongside the session date and item type
-- (stored in service_sessions.session_type, e.g. 'IFSP Meeting' /
-- 'Amendment Meeting'). The two contractor policies mirror documents_contractor_*:
-- a contractor may submit their OWN pending sessions for a client they serve, and
-- read their own sessions. Admin approval (service_sessions_admin_all) still
-- gates billing.
-- ============================================================================

alter table public.service_sessions
  add column if not exists child_initials text,
  add column if not exists eiid text;

-- Contractors may insert their OWN pending sessions for a client they're linked
-- to. Defense-in-depth alongside the server action's checks (writes go through
-- the service role after requireWorker(), mirroring documents upload).
drop policy if exists "service_sessions_contractor_insert" on public.service_sessions;
create policy "service_sessions_contractor_insert" on public.service_sessions
  for insert to authenticated
  with check (
    worker_id = public.my_worker_id()
    and approval = 'pending'::public.approval_status
    and approved_by is null
    and (select public.is_onboarded())
    and exists (
      select 1
      from public.worker_companies wc
      join public.companies c on c.id = wc.company_id
      where wc.worker_id = public.my_worker_id()
        and wc.company_id = service_sessions.company_id
        and wc.status = 'active'
        and c.kind = 'client'
    )
  );

-- Contractors may read their own sessions (any approval state).
drop policy if exists "service_sessions_contractor_read" on public.service_sessions;
create policy "service_sessions_contractor_read" on public.service_sessions
  for select to authenticated
  using (
    worker_id = (select public.my_worker_id())
    and (select public.is_onboarded())
  );

-- ROLLBACK:
--   drop policy if exists "service_sessions_contractor_read" on public.service_sessions;
--   drop policy if exists "service_sessions_contractor_insert" on public.service_sessions;
--   alter table public.service_sessions drop column if exists eiid;
--   alter table public.service_sessions drop column if exists child_initials;
