-- ============================================================================
-- 38: no time may be recorded after a contractor's last day — enforced in the DB
-- ----------------------------------------------------------------------------
-- The app-side guard (upsertTimeEntries, src/db/queries/time.ts) covers the one
-- door THIS repo has. Prod is shared: three original apps still write
-- time_entries straight from the browser under `time_entries_admin_all` RLS,
-- with no last-day rule at all —
--   abc-work-app-payroll-wis-hubstaff-app/app/index.html:4523, 5445, 5486, 5531
--   abc-work-app-payroll-mobile/app/index.html:2858, 3728, 3768, 3813
--   the deployed legacy hubstaff-sync edge function (…/functions/hubstaff-sync/
--     index.ts:468), which upserts a Hubstaff window nightly and cannot be
--     fixed from this repo
-- A trigger is the only fix that reaches all of them without a deploy.
--
-- The realistic failure it stops: an admin runs the Hubstaff CSV import in the
-- legacy admin app (still the rollback / parallel tool). Hubstaff keeps
-- reporting a departed contractor's org membership, so their post-last-day days
-- land as `pending` — and this app's /time screen then offers them for approval
-- and pay.
--
-- WHEN IT FIRES
--   INSERT — always. This is the CSV-import / nightly-sync case.
--   UPDATE — only when the write could create NEW payable time past the last
--            day: the row is re-pointed at a different (worker, company, date),
--            or its hours go UP. Everything else is exempt, deliberately:
--              * approve / reject bulk updates (…/index.html:5551, 5564) — the
--                cleanup path for rows that predate this trigger. Blocking it
--                would strand exactly the bad rows an admin is trying to reject.
--              * pay_period_id assignment, activity_pct fill
--                (set_time_entry_activity), notes
--              * lowering or zeroing hours (the legacy "edit total for the
--                period" flow zeroes the trailing days)
--            An UPDATE that only re-points worker_id — legacy
--            index.html:4523 attaching orphan rows to a worker — IS checked.
--
-- WHAT IT TOLERATES (matching the app-side guard exactly, so the two agree)
--   * worker_id NULL — an unmatched import row, bounded by nothing
--   * no worker_companies row for the pair — nothing to measure against
--   * an 'ended' link with NULL ended_on — the #79 drift; migration 37's
--     backfill clears these, but a DB where 37 has not run must not start
--     dropping real hours on a guess
--
-- WHY `raise` AND NOT A SILENT SKIP: a BEFORE trigger returning NULL would drop
-- the row exactly as the app does — but a trigger cannot report a count back to
-- a legacy CSV import, so the operator would see "imported N" and never learn
-- what vanished. Loud beats silent for a rule the calling app does not know
-- about. The message and hint are written for someone reading them inside the
-- legacy admin app with no access to this repo.
--
-- Cost: one lookup on worker_companies per written row, served by
-- worker_companies_worker_id_company_id_key. The name lookup happens only on
-- the rejection path.
--
-- ADDITIVE per docs/shared-prod-conformance.md — a new function + two new
-- triggers, no existing object renamed, dropped or retyped. It is nonetheless a
-- LIVE BEHAVIOUR CHANGE for the legacy admin apps: from the moment it applies,
-- their imports fail loudly on post-last-day rows instead of silently creating
-- payable time. That is the ticket.
--
-- ⚠️ Local/CI only — the prod copy is hand-applied via the Dashboard/MCP
-- (disjoint history), then recorded in supabase/prod-applied.json. IDEMPOTENT.
-- ============================================================================

create or replace function public.time_entries_no_time_after_last_day() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_ended_on date;
  v_name     text;
begin
  -- Nothing to measure against.
  if new.worker_id is null then
    return new;
  end if;

  -- Exempt UPDATEs that cannot create new payable time past the last day.
  if tg_op = 'UPDATE'
     and new.worker_id       is not distinct from old.worker_id
     and new.company_id      is not distinct from old.company_id
     and new.work_date       is not distinct from old.work_date
     and new.tracked_seconds <= old.tracked_seconds
     and new.pto_seconds     <= old.pto_seconds
  then
    return new;
  end if;

  -- The last day this worker may log time AT THIS COMPANY. Scoped to the link
  -- the hours land on, not to the worker: ending ONE client assignment leaves
  -- the employer link (which holds all time) open, and those hours must keep
  -- flowing. No row, or a row with no last day, means no bound.
  select wc.ended_on
    into v_ended_on
    from public.worker_companies wc
   where wc.company_id = new.company_id
     and wc.worker_id  = new.worker_id;

  if v_ended_on is null or new.work_date <= v_ended_on then
    return new;
  end if;

  select btrim(concat_ws(' ', w.first_name, w.middle_name, w.last_name))
    into v_name
    from public.workers w
   where w.id = new.worker_id;

  raise exception
    'Time entry rejected: % worked through % at this company, so % cannot be recorded.',
    coalesce(nullif(v_name, ''), new.source_name), v_ended_on, new.work_date
    using errcode = 'check_violation',
          hint = format(
            'This contractor''s engagement ended on %s and no time may be recorded after a last day. Remove the dates after %s from this import (everything up to and including %s still imports, approves and pays), or — if they are in fact still working — clear their end date on the contractor roster first.',
            v_ended_on, v_ended_on, v_ended_on);
end;
$$;

alter function public.time_entries_no_time_after_last_day() owner to postgres;

create or replace trigger trg_time_entries_no_time_after_last_day_ins
  before insert on public.time_entries
  for each row execute function public.time_entries_no_time_after_last_day();

create or replace trigger trg_time_entries_no_time_after_last_day_upd
  before update on public.time_entries
  for each row execute function public.time_entries_no_time_after_last_day();

grant all on function public.time_entries_no_time_after_last_day() to anon;
grant all on function public.time_entries_no_time_after_last_day() to authenticated;
grant all on function public.time_entries_no_time_after_last_day() to service_role;

-- ROLLBACK:
--   drop trigger if exists trg_time_entries_no_time_after_last_day_upd on public.time_entries;
--   drop trigger if exists trg_time_entries_no_time_after_last_day_ins on public.time_entries;
--   drop function if exists public.time_entries_no_time_after_last_day();
