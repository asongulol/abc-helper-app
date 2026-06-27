-- ============================================================================
-- Off-cycle per-session / per-hour pay
-- ----------------------------------------------------------------------------
-- Lets an admin pay a per-session/per-hour contractor for a session or hour
-- block that falls OUTSIDE the current pay-period date window (a late/makeup
-- session, a one-off), with a hard guard against paying the same session — or
-- the same (employer, worker, work_date) for hourly — twice.
--
-- Model: a durable ledger (off_cycle_pay_items) that the payroll engine
-- re-applies on every calculate, so the line survives recalc — unlike
-- misc_items, which calculateDraft resets to []. Each item lands as an extra
-- earnings line on the worker's CURRENT OPEN pay-period payment and flows
-- through the normal statements + Wise payout (net_php). Dedup is enforced by
-- partial-unique indexes on the ledger; a mirrored service_sessions.paid_at
-- marker also excludes already-paid sessions from the normal windowed pay sum.
--
-- ⚠️ Local/CI ONLY — do NOT push to the shared prod DB (its migration history is
-- disjoint; prod-side changes are applied via the Dashboard SQL Editor). See the
-- migration 19 header / docs/PROD-CONFORMANCE-PLAN.md. ADDITIVE + IDEMPOTENT.
-- ============================================================================

-- 1. Worker-pay paid marker on sessions — distinct from `approval` (the billing
--    gate) and from client invoicing. Stamped when a session is paid via an
--    off-cycle item (or, optionally, when its period locks); excludes the
--    session from the normal date-windowed pay sum so it can't be re-paid.
alter table public.service_sessions
  add column if not exists paid_at timestamp with time zone,
  add column if not exists paid_pay_period_id uuid references public.pay_periods (id),
  add column if not exists paid_payment_id uuid references public.payments (id);

create index if not exists service_sessions_unpaid_idx
  on public.service_sessions (worker_id, session_date) where paid_at is null;

-- 2. Discrete off-cycle earnings line on the payment row (so the payslip + draft
--    table can show it). net_php still carries the authoritative total.
alter table public.payments
  add column if not exists off_cycle_php numeric(12,2) not null default 0;

-- 3. Durable off-cycle pay ledger. company_id = EMPLOYER (where the pay lands).
create table if not exists public.off_cycle_pay_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid not null references public.workers (id) on delete cascade,
  pay_period_id uuid not null references public.pay_periods (id) on delete cascade,
  basis text not null check (basis in ('per_session', 'per_hour')),
  session_id uuid references public.service_sessions (id) on delete set null,
  work_date date,
  units numeric(12,2),
  rate_php numeric(12,2),
  amount_php numeric(12,2) not null check (amount_php >= 0),
  description text,
  created_by uuid default auth.uid(),
  created_at timestamp with time zone not null default now(),
  -- Every row is identifiable: a real session (pick mode) or a work_date (manual).
  constraint off_cycle_identifiable
    check (session_id is not null or work_date is not null),
  -- Hourly rows are date-based (no discrete session record).
  constraint off_cycle_hour_requires_date
    check (basis <> 'per_hour' or work_date is not null)
);

comment on table public.off_cycle_pay_items is
  'Off-cycle per-session/per-hour pay lines, re-applied by the payroll engine on each calculate. company_id = EMPLOYER. amount_php is a snapshot (units × rate at add-time); never re-priced.';

-- Dedup #1 (pick mode): a real session is paid at most once across the ledger.
create unique index if not exists off_cycle_session_uniq
  on public.off_cycle_pay_items (session_id) where session_id is not null;
-- Dedup #2 (manual mode, incl. all per_hour): one manual off-cycle entry per
-- (employer, worker, work_date). Pick-mode rows carry a session_id and are
-- excluded here, so a per-session worker may still have several real sessions on
-- one date.
create unique index if not exists off_cycle_manual_date_uniq
  on public.off_cycle_pay_items (company_id, worker_id, work_date) where session_id is null;

create index if not exists off_cycle_period_idx
  on public.off_cycle_pay_items (company_id, pay_period_id);
create index if not exists off_cycle_worker_idx
  on public.off_cycle_pay_items (worker_id);

alter table public.off_cycle_pay_items owner to postgres;

-- RLS: owner or an admin of the EMPLOYER company (same shape as time_entries /
-- payments). my_admin_company_ids() returns the admin's company ids.
alter table public.off_cycle_pay_items enable row level security;

create policy "off_cycle_admin_all" on public.off_cycle_pay_items
  to authenticated
  using (
    (select public.is_owner()) or (company_id in (select unnest(public.my_admin_company_ids())))
  )
  with check (
    (select public.is_owner()) or (company_id in (select unnest(public.my_admin_company_ids())))
  );

grant all on table public.off_cycle_pay_items to anon;
grant all on table public.off_cycle_pay_items to authenticated;
grant all on table public.off_cycle_pay_items to service_role;

-- 4. Freeze off_cycle_php once the period leaves 'open' — extend the migration-18
--    enforce fn (CREATE OR REPLACE) to add it to the monetary/computed set.
create or replace function "public"."payments_period_open_enforce"() returns "trigger"
    language "plpgsql"
    set "search_path" to 'public', 'pg_temp'
    as $$
declare
  v_state public.pay_period_state;
  changed_cols text[] := '{}';
begin
  -- INSERT: payments may only be created for an open period.
  if (tg_op = 'INSERT') then
    select state into v_state from public.pay_periods where id = new.pay_period_id;
    if v_state::text is distinct from 'open' then
      raise exception
        'cannot insert payment for pay_period % in state % (must be open)',
        new.pay_period_id, v_state
        using errcode = 'check_violation',
              hint = 'Unlock the period before recalculating.';
    end if;
    return new;
  end if;

  -- UPDATE: detect changes to frozen (monetary / computed) columns only.
  if new.expected_hours       is distinct from old.expected_hours       then changed_cols := array_append(changed_cols,'expected_hours'); end if;
  if new.worked_hours         is distinct from old.worked_hours         then changed_cols := array_append(changed_cols,'worked_hours'); end if;
  if new.performance_ratio    is distinct from old.performance_ratio    then changed_cols := array_append(changed_cols,'performance_ratio'); end if;
  if new.rate_php             is distinct from old.rate_php             then changed_cols := array_append(changed_cols,'rate_php'); end if;
  if new.gross_php            is distinct from old.gross_php            then changed_cols := array_append(changed_cols,'gross_php'); end if;
  if new.health_allowance_php is distinct from old.health_allowance_php then changed_cols := array_append(changed_cols,'health_allowance_php'); end if;
  if new.thirteenth_month_php is distinct from old.thirteenth_month_php then changed_cols := array_append(changed_cols,'thirteenth_month_php'); end if;
  if new.pdd_lunch_php        is distinct from old.pdd_lunch_php        then changed_cols := array_append(changed_cols,'pdd_lunch_php'); end if;
  if new.bonus_php            is distinct from old.bonus_php            then changed_cols := array_append(changed_cols,'bonus_php'); end if;
  if new.deduction_php        is distinct from old.deduction_php        then changed_cols := array_append(changed_cols,'deduction_php'); end if;
  if new.off_cycle_php        is distinct from old.off_cycle_php        then changed_cols := array_append(changed_cols,'off_cycle_php'); end if;
  if new.net_php              is distinct from old.net_php              then changed_cols := array_append(changed_cols,'net_php'); end if;
  if new.misc_items           is distinct from old.misc_items           then changed_cols := array_append(changed_cols,'misc_items'); end if;
  if new.worker_id            is distinct from old.worker_id            then changed_cols := array_append(changed_cols,'worker_id'); end if;
  if new.pay_period_id        is distinct from old.pay_period_id        then changed_cols := array_append(changed_cols,'pay_period_id'); end if;

  -- Only operational columns changed → allowed in any state.
  if array_length(changed_cols, 1) is null then
    return new;
  end if;

  select state into v_state from public.pay_periods where id = new.pay_period_id;
  if v_state::text is distinct from 'open' then
    raise exception
      'pay_period % is %; cannot change frozen payment column(s): %',
      new.pay_period_id, v_state, array_to_string(changed_cols, ', ')
      using errcode = 'check_violation',
            hint = 'Unlock the period before recalculating.';
  end if;
  return new;
end;
$$;

ALTER FUNCTION "public"."payments_period_open_enforce"() OWNER TO "postgres";

-- ROLLBACK:
--   (restore migration 18's function body without off_cycle_php)
--   drop table if exists public.off_cycle_pay_items;
--   alter table public.payments drop column if exists off_cycle_php;
--   alter table public.service_sessions
--     drop column if exists paid_at,
--     drop column if exists paid_pay_period_id,
--     drop column if exists paid_payment_id;
