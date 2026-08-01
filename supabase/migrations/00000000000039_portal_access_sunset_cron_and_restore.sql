-- ============================================================================
-- 39: portal access really ends when the money lands — and comes back on rehire
-- ----------------------------------------------------------------------------
-- #85. `507d16f` ends a departed contractor's portal access once their final pay
-- has landed, but only inside THIS app's resolver (src/server/auth/worker.ts).
-- `contractor_logins.status` stayed 'active', and that column is the entire
-- contractor RLS story: `my_worker_id()` (baseline) resolves any login row with
-- status = 'active', so every contractor policy — workers, payments,
-- pay_periods, time_entries, service_sessions, documents, plus the
-- mood_checkins / documents inserts — still granted everything to someone this
-- app had already decided was done. The exposed client is not this app: it is
-- portal.abbilabs.com on the same DB (pending cutover) and raw PostgREST with a
-- still-valid email + password, neither of which executes a line of our code.
--
-- Two halves, both here because both must work for writers we do not control:
--
--  1. SCHEDULE (`portal-access-sunset`, daily 21:30 UTC / 05:30 Asia/Manila).
--     A resolve-time flip only fires when the departed contractor visits THIS
--     app — which is exactly what they never have to do. A flip inside the
--     payment path only fires for money moved by THIS app — and the legacy apps
--     stamp `paid_at` on the same shared DB. A nightly pass over DB state is the
--     one trigger that does not depend on which app acted. It POSTs the Next
--     route /api/cron/portal-sunset (same shape as the two digests in migration
--     0016), which runs `sunsetPortalLogins` → `hasPayOutstanding` per candidate.
--     The predicate stays in TypeScript, in one place, deliberately: it is the
--     same one the resolver uses, and a second SQL copy would drift.
--
--     Latency is up to 24h, on purpose. Every unknown in the predicate resolves
--     to "still owed" and the sweep only revokes on a hard false — locking out
--     someone still owed money is the expensive mistake, a late revocation is
--     not.
--
--  2. RESTORE trigger. Revocation is now automatic, so its inverse cannot stay
--     manual-only: a rehire (workers.status leaving 'ended') puts the login back
--     to 'active'. In the DB rather than in the reactivation action because the
--     legacy admin apps reactivate on this same shared DB and never call ours —
--     the same reason the revocation is scheduled rather than hooked. It only
--     ever lifts 'revoked' → 'active' for a worker an admin explicitly brought
--     back; it cannot fire for anyone who was never ended.
--
--     Its narrowness is the point: the sweep itself must NEVER restore, because
--     it cannot tell its own revocation from an admin's deliberate one. The
--     remaining case — still ended, but owed again after a re-drafted or bounced
--     payment — is a deliberate manual click (`restorePortalLogin`).
--
-- SECURITY DEFINER: `contractor_logins` has exactly one RLS policy and it is
-- SELECT-only, so the trigger's UPDATE would match 0 rows running as the
-- invoking user (the same reason `revokePortalLogin` was silently a no-op until
-- this stack moved it to the service client).
--
-- ADDITIVE per docs/shared-prod-conformance.md: one new cron job, one new
-- function, one new trigger. Nothing renamed, dropped or retyped. It IS a live
-- behaviour change: from the moment it applies, an ended-and-fully-paid
-- contractor loses portal access within a day — including in the legacy portal.
-- That is the ticket.
--
-- PROJECT-SPECIFIC: `app_secrets.app_base_url` must point at the DEPLOYED app
-- (migration 0016 seeds a CHANGE-ME placeholder) or the job POSTs nowhere, and
-- the app's CRON_SECRET must match `app_secrets.cron_secret`.
--
-- IDEMPOTENT — cron.schedule upserts by job name; the function and trigger are
-- create-or-replace.
-- ============================================================================

BEGIN;

-- 1. Nightly sunset sweep. 21:30 UTC: after the 18:00 Wise reconcile has had a
--    chance to stamp the day's landed transfers, and after the two digests.
select cron.schedule(
  'portal-access-sunset',
  '30 21 * * *',
  $job$
  select net.http_post(
    url := (select value from public.app_secrets where key = 'app_base_url') || '/api/cron/portal-sunset',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- 2. Reactivation restores the login.
create or replace function public.workers_reactivation_restores_portal_login() returns trigger
    language plpgsql
    security definer
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if old.status = 'ended' and new.status is distinct from old.status then
    update public.contractor_logins
       set status = 'active'
     where worker_id = new.id
       and status = 'revoked';
  end if;
  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

alter function public.workers_reactivation_restores_portal_login() owner to postgres;

create or replace trigger trg_workers_reactivation_restores_portal_login
  after update of status on public.workers
  for each row execute function public.workers_reactivation_restores_portal_login();

grant all on function public.workers_reactivation_restores_portal_login() to anon;
grant all on function public.workers_reactivation_restores_portal_login() to authenticated;
grant all on function public.workers_reactivation_restores_portal_login() to service_role;

COMMIT;

-- ROLLBACK:
--   select cron.unschedule('portal-access-sunset');
--   drop trigger if exists trg_workers_reactivation_restores_portal_login on public.workers;
--   drop function if exists public.workers_reactivation_restores_portal_login();
