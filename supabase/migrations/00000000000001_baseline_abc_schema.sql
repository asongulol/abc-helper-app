-- ============================================================================
-- HR & Payroll system for PH-based independent contractors
-- Target: Supabase (PostgreSQL 15+).  Admin-only for now; RLS-ready.
-- ----------------------------------------------------------------------------
-- DESIGN NOTES
--  * All workers are PH-based INDEPENDENT CONTRACTORS. No US payroll, no
--    withholding, no 1099. Per-worker US doc is a W-8BEN (in documents).
--  * Multi-company, many-to-many: a contractor may serve >1 company, with
--    role + PHP rate set PER company (worker_companies + rates).
--  * Everything operational is scoped by company_id so payroll runs and
--    reports are per-company, with a consolidated view available by union.
--  * Money: rates in PHP; payouts usually USD. Every payment records an FX
--    rate so PHP and USD reconcile. Phase 2 writes the real Wise FX back.
--  * All timestamps are stored UTC (timestamptz). Hubstaff day buckets are
--    normalized to PH time (Asia/Manila, UTC+8) on import; see time_entries.
--  * Compliance: we store the signed IC agreement + W-8BEN per worker and
--    deliberately AVOID employee-style supervision fields (no schedules to
--    enforce, no disciplinary tracking) to reduce PH misclassification risk
--    under the DOLE control test.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------- enums -----------------------------------------------------------
create type company_status   as enum ('active', 'inactive');
create type worker_status     as enum ('active', 'inactive', 'ended');
create type contract_type     as enum ('FT', 'PT');
create type payout_method      as enum ('wise', 'bpi', 'gcash', 'paymaya', 'paypal');
create type approval_status     as enum ('pending', 'approved', 'rejected');
create type pay_period_state     as enum ('open', 'locked', 'paid');
create type payment_status        as enum ('draft', 'queued', 'sent', 'failed', 'reconciled');
create type document_kind          as enum ('ic_agreement', 'w8ben', 'gov_id', 'other');

-- ---------- companies -------------------------------------------------------
-- e.g. Ability Builders, Nightingale Process Management.
create table companies (
    id            uuid primary key default gen_random_uuid(),
    name          text not null unique,
    status        company_status not null default 'active',
    -- The Hubstaff organization this company's time comes from (one Hubstaff
    -- org may feed one company). Used to map imports -> company.
    hubstaff_org_id  bigint,
    created_at    timestamptz not null default now()
);

-- ---------- workers (the contractor, identity-level, company-agnostic) ------
create table workers (
    id              uuid primary key default gen_random_uuid(),
    first_name      text not null,
    last_name       text not null,
    -- normalized "first last" used to match Hubstaff display names on import
    match_key       text generated always as (
                        lower(trim(first_name)) || ' ' || lower(trim(last_name))
                    ) stored,
    status          worker_status not null default 'active',
    email           text,
    mobile          text,
    ph_address      text,                       -- PH home address
    date_of_birth   date,
    hire_date       date,                       -- engagement start (for tenure/HA/13th)
    -- payout details. NULL = not yet chosen (flagged in the app).
    -- Channels: wise | bpi | gcash | paymaya | paypal
    payout_method   payout_method,
    payout_account  jsonb,                       -- {wise_email, bank, acct_no, ...}
    -- Wise recipient identifiers (IDs only — NOT bank details). Recipients are
    -- created in Wise; the app just references them to draft transfers.
    -- wise_recipients: list of saved profiles e.g. [{"id":123,"label":"BPI peso","uuid":"33e5..."}]
    -- wise_recipient_id: the LAST-USED recipient numeric id (the payout default; API).
    -- wise_recipient_uuid: default recipient's Wise UUID — used by the manual
    --   Batch Payments CSV (recipientId). API gives the numeric id; only the
    --   "download all templates" export carries this UUID. Stable per account.
    wise_recipients      jsonb default '[]'::jsonb,
    wise_recipient_id    bigint,
    wise_recipient_uuid  text,
    -- backup local wallets (informational; from Benefits 201 file)
    gcash           text,
    paymaya         text,
    paypal          text,
    -- benefits flags
    health_allowance_eligible  boolean not null default true,
    thirteenth_month_eligible  boolean not null default true,
    -- optional contractor photo. Stored as a small (256px) center-cropped JPEG
    -- data URI, so no Storage bucket / RLS is required. NULL = use initials.
    photo_url       text,
    created_at      timestamptz not null default now()
);
create index on workers (match_key);

-- ---------- worker_companies (many-to-many; role + default scope per company)
create table worker_companies (
    id            uuid primary key default gen_random_uuid(),
    worker_id     uuid not null references workers(id) on delete cascade,
    company_id    uuid not null references companies(id) on delete cascade,
    role          text,                              -- e.g. "Billing Associate"
    contract      contract_type not null default 'FT',
    -- exact name as it appears in THIS company's Hubstaff export (for matching)
    hubstaff_name text,
    -- stable Hubstaff user id (preferred match key; immune to name changes)
    hubstaff_user_id bigint,
    status        worker_status not null default 'active',
    started_on    date,
    ended_on      date,
    unique (worker_id, company_id)
);
create index on worker_companies (company_id);
-- a Hubstaff user maps to at most one link per company (only where id is set)
create unique index if not exists worker_companies_company_hubstaff_user
  on worker_companies (company_id, hubstaff_user_id)
  where hubstaff_user_id is not null;

-- ---------- rates (effective-dated, PHP, per worker+company) ----------------
-- The PER-PERIOD (semi-monthly) PHP amount, matching the existing workbook's
-- "Rate" column. Monthly = rate * 2 (paid 15th and month-end).
create table rates (
    id            uuid primary key default gen_random_uuid(),
    worker_id     uuid not null references workers(id) on delete cascade,
    company_id    uuid not null references companies(id) on delete cascade,
    amount_php    numeric(12,2) not null,
    period_basis  text not null default 'semi_monthly',  -- semi_monthly | monthly | hourly
    effective_start date not null,
    effective_end   date,                                  -- null = current
    note          text,
    created_at    timestamptz not null default now(),
    check (effective_end is null or effective_end >= effective_start)
);
create index on rates (worker_id, company_id, effective_start);

-- ---------- pay_periods (scoped to one company; has a lock state) -----------
create table pay_periods (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references companies(id) on delete cascade,
    period_start  date not null,            -- e.g. 2026-05-01
    period_end    date not null,            -- e.g. 2026-05-15
    pay_date      date,                      -- 15th or month-end
    state         pay_period_state not null default 'open',
    expected_hours_ft  numeric(6,2) not null default 80,
    expected_hours_pt  numeric(6,2) not null default 40,
    locked_at     timestamptz,
    created_at    timestamptz not null default now(),
    unique (company_id, period_start, period_end),
    check (period_end >= period_start)
);

-- ---------- time_entries (imported from Hubstaff; approval workflow) --------
-- One row per worker per day per company. Hubstaff day buckets are already
-- per-day; we keep the worked seconds and the PH-local date.
create table time_entries (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    worker_id       uuid references workers(id) on delete set null,
    -- keep the raw Hubstaff name so unmatched rows are still importable/visible
    source_name     text not null,
    work_date       date not null,           -- PH-local (Asia/Manila) calendar day
    tracked_seconds integer not null default 0,
    -- Paid + approved PTO from Hubstaff time_off_requests, per day. Populated
    -- by hubstaff-sync alongside tracked. Counted toward worked_hours in
    -- payroll so PTO leave gets paid. CSV imports default to 0 (manual
    -- imports don't have a PTO source to pull from).
    pto_seconds     integer not null default 0,
    project         text,
    activity_pct    numeric(5,2),
    approval        approval_status not null default 'pending',
    approved_by     uuid,                     -- admin user id (auth.users) later
    approved_at     timestamptz,
    pay_period_id   uuid references pay_periods(id) on delete set null,
    import_batch_id uuid,                     -- groups one CSV/API import
    created_at      timestamptz not null default now(),
    unique (company_id, source_name, work_date)
);
create index on time_entries (company_id, work_date);
create index on time_entries (pay_period_id);
create index on time_entries (worker_id);

-- ---------- payments (one per worker per pay_period) ------------------------
-- Mirrors the existing pay-statement: gross PHP from rate * performance,
-- + health allowance + 13th-month component, then FX to the payout currency.
create table payments (
    id                uuid primary key default gen_random_uuid(),
    company_id        uuid not null references companies(id) on delete cascade,
    pay_period_id     uuid not null references pay_periods(id) on delete cascade,
    worker_id         uuid not null references workers(id) on delete cascade,
    -- computation snapshot (so a locked period is immutable & auditable)
    expected_hours    numeric(6,2),
    worked_hours      numeric(8,4),
    performance_ratio numeric(6,4),            -- min(worked/expected, cap)
    rate_php          numeric(12,2),           -- the rate applied
    gross_php         numeric(12,2) not null default 0,   -- expected disbursement
    health_allowance_php numeric(12,2) not null default 0,
    pdd_lunch_php     numeric(12,2) not null default 0,
    bonus_php         numeric(12,2) not null default 0,
    thirteenth_month_php  numeric(12,2) not null default 0,
    deduction_php     numeric(12,2) not null default 0,
    net_php           numeric(12,2) not null default 0,   -- adjusted disbursement
    -- When the Reconcile matcher finds a variance (DB ≠ Wise) and there's
    -- exactly one candidate transfer, it auto-overrides net_php with the
    -- amount Wise actually sent and preserves the old value here. Lets the
    -- UI show "was X, now Y" so the override is visible, not hidden.
    -- NULL = no override has happened. Non-NULL = net_php is the post-Wise
    -- amount, this column is the original pre-Wise DB amount.
    original_net_php  numeric(12,2),
    -- FX + payout
    fx_rate           numeric(14,6),           -- PHP per 1 unit payout currency
    payout_currency   text not null default 'USD',
    payout_amount     numeric(12,2),           -- net_php converted at fx_rate
    payout_method     payout_method,
    -- Wise (Phase 2)
    wise_transfer_id  text,
    -- All three Wise transfer timestamps, populated by matcher/poll from the
    -- /v1/transfers response: { created, dateFunded, dateSent }. Lets the UI
    -- show the real Wise pay date instead of "when we noticed it" (paid_at).
    wise_dates        jsonb,
    -- Lock timestamp: set by the smart Reconcile button when Wise confirms
    -- this row. When non-null the row is treated as locked — UI disables edit
    -- affordances, and a trigger logs warnings if anything tries to update
    -- non-allowed columns (everything except note / wise_locked_at / wise_dates).
    -- Unlock = clear this column via the per-row Unlock admin action.
    wise_locked_at    timestamptz,
    -- Free-form labeled pay add-ons that don't fit a single typed column.
    -- Each entry: { kind: "other_earns"|"other_hours", label, amount,
    -- hours?, hourly_rate? }. Sum of amount adds to net_php. Other Hours
    -- prices labeled hours at the contractor's effective hourly rate
    -- (rate * 24 / 2080) captured at entry time so historical periods are
    -- not retroactively repriced when rates change.
    misc_items        jsonb not null default '[]'::jsonb
                       check (jsonb_typeof(misc_items) = 'array'),
    status            payment_status not null default 'draft',
    paid_at           timestamptz,
    note              text,
    created_at        timestamptz not null default now(),
    unique (pay_period_id, worker_id)
);
create index on payments (company_id);
create index on payments (pay_period_id);

-- ---------- documents (IC agreement, W-8BEN, IDs; expiry reminders) ---------
create table documents (
    id            uuid primary key default gen_random_uuid(),
    worker_id     uuid not null references workers(id) on delete cascade,
    company_id    uuid references companies(id) on delete set null,  -- IC agreement is per-company
    kind          document_kind not null,
    title         text,
    storage_path  text,                       -- Supabase Storage object path
    signed_on     date,
    expires_on    date,                        -- drives reminders; null = no expiry
    created_at    timestamptz not null default now()
);
create index on documents (worker_id);
create index on documents (expires_on);

-- ---------- audit_log (who/what/when for overrides & key actions) -----------
create table audit_log (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid references companies(id) on delete set null,
    actor         text,                         -- admin identity (email) when available
    action        text not null,                -- e.g. 'override.gross','manual.hours','approve','lock','mark_paid','import','delete'
    entity        text,                         -- what it touched (contractor name, period, batch)
    detail        jsonb,                        -- { from, to, period, note, ... }
    created_at    timestamptz not null default now()
);
create index on audit_log (company_id, created_at);
create index on audit_log (action);

-- ---------- api_tokens (server-side rotating tokens, e.g. Hubstaff) ----------
-- Hubstaff rotates its refresh token on every exchange, so it can't live in a
-- static secret — the hubstaff-sync function reads & writes the current token here.
create table api_tokens (
    provider      text primary key,             -- 'hubstaff'
    refresh_token text not null,
    access_token  text,                          -- cached short-lived access token
    access_expires_at timestamptz,               -- when the access token expires
    updated_at    timestamptz not null default now()
);

-- ---------- a view for the consolidated (all-company) payout report ---------
-- SECURITY INVOKER is set EXPLICITLY here. Without it Supabase flags this view
-- as "Security Definer View — CRITICAL" because a definer-rights view executes
-- with the view-owner's permissions and silently bypasses row-level security
-- on the underlying tables. With SECURITY INVOKER the querying user's RLS
-- policies on payments / pay_periods / companies apply normally.
create view v_payouts_by_period
with (security_invoker = true) as
select
    p.company_id,
    c.name              as company_name,
    pp.period_start,
    pp.period_end,
    count(*)            as contractor_count,
    sum(p.net_php)      as total_net_php,
    sum(p.payout_amount) as total_payout,
    p.payout_currency
from payments p
join pay_periods pp on pp.id = p.pay_period_id
join companies   c  on c.id  = p.company_id
group by p.company_id, c.name, pp.period_start, pp.period_end, p.payout_currency;

-- ============================================================================
-- RLS — allowlist model (Phase 2, applied 2026-05-30; see
-- migrations/2026-05-30_phase2_rls_admin.sql). Only an AUTHENTICATED user in
-- admin_users (is_admin()) can touch payroll data; the anon key alone grants
-- nothing. Auth = Supabase Auth + Google. Service role bypasses RLS (recovery).
-- For per-company logins later, swap is_admin() for a membership check, e.g.:
--   using ( company_id in (select company_id from memberships
--                          where user_id = auth.uid()) )
-- ============================================================================
create table if not exists admin_users (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text unique not null,
  role     text not null default 'admin',
  added_at timestamptz not null default now()
);
alter table admin_users enable row level security;
create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;
drop policy if exists admin_users_read on admin_users;
create policy admin_users_read on admin_users for select to authenticated using (is_admin());

alter table companies        enable row level security;
alter table workers          enable row level security;
alter table worker_companies enable row level security;
alter table rates            enable row level security;
alter table pay_periods      enable row level security;
alter table time_entries     enable row level security;
alter table payments         enable row level security;
alter table documents        enable row level security;
alter table audit_log        enable row level security;

-- Authenticated + allowlisted admin can do everything. (Service role bypasses RLS.)
do $$
declare t text;
begin
  foreach t in array array['companies','workers','worker_companies','rates',
                           'pay_periods','time_entries','payments','documents','audit_log']
  loop
    execute format('drop policy if exists %I_admin_all on %I;', t, t);
    execute format('drop policy if exists %I_anon_all on %I;', t, t);
    execute format(
      'create policy %I_admin_all on %I for all to authenticated using (is_admin()) with check (is_admin());',
      t, t);
  end loop;
end$$;

-- ============================================================================
-- Payment lock enforcement (M1, 2026-06-06)
-- Once Wise confirms a payment we set payments.wise_locked_at; from then on the
-- disbursed-amount snapshot + identity are FROZEN — a re-import/re-calc must not
-- silently rewrite what was paid. This BEFORE UPDATE trigger hard-blocks changes
-- to those PROTECTED columns on a locked row. PERMITTED-on-locked (not listed in
-- the trigger) = note, wise_locked_at, wise_dates, status, fx_rate,
-- wise_transfer_id, paid_at — the settlement/reconcile columns. To edit a frozen
-- amount: Unlock the row (clears wise_locked_at in its own UPDATE) → edit.
-- See schema/migrations/2026-06-06_payments_hard_lock.sql (incl. rollback).
-- ============================================================================
create or replace function payments_lock_enforce() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  changed_cols text[] := '{}';
begin
  if old.wise_locked_at is null then
    return new;
  end if;
  if new.company_id           is distinct from old.company_id           then changed_cols := array_append(changed_cols,'company_id'); end if;
  if new.pay_period_id        is distinct from old.pay_period_id        then changed_cols := array_append(changed_cols,'pay_period_id'); end if;
  if new.worker_id            is distinct from old.worker_id            then changed_cols := array_append(changed_cols,'worker_id'); end if;
  if new.expected_hours       is distinct from old.expected_hours       then changed_cols := array_append(changed_cols,'expected_hours'); end if;
  if new.worked_hours         is distinct from old.worked_hours         then changed_cols := array_append(changed_cols,'worked_hours'); end if;
  if new.performance_ratio    is distinct from old.performance_ratio    then changed_cols := array_append(changed_cols,'performance_ratio'); end if;
  if new.rate_php             is distinct from old.rate_php             then changed_cols := array_append(changed_cols,'rate_php'); end if;
  if new.gross_php            is distinct from old.gross_php            then changed_cols := array_append(changed_cols,'gross_php'); end if;
  if new.health_allowance_php is distinct from old.health_allowance_php then changed_cols := array_append(changed_cols,'health_allowance_php'); end if;
  if new.pdd_lunch_php        is distinct from old.pdd_lunch_php        then changed_cols := array_append(changed_cols,'pdd_lunch_php'); end if;
  if new.bonus_php            is distinct from old.bonus_php            then changed_cols := array_append(changed_cols,'bonus_php'); end if;
  if new.thirteenth_month_php is distinct from old.thirteenth_month_php then changed_cols := array_append(changed_cols,'thirteenth_month_php'); end if;
  if new.deduction_php        is distinct from old.deduction_php        then changed_cols := array_append(changed_cols,'deduction_php'); end if;
  if new.net_php              is distinct from old.net_php              then changed_cols := array_append(changed_cols,'net_php'); end if;
  if new.original_net_php     is distinct from old.original_net_php     then changed_cols := array_append(changed_cols,'original_net_php'); end if;
  if new.payout_currency      is distinct from old.payout_currency      then changed_cols := array_append(changed_cols,'payout_currency'); end if;
  if new.payout_amount        is distinct from old.payout_amount        then changed_cols := array_append(changed_cols,'payout_amount'); end if;
  if new.payout_method        is distinct from old.payout_method        then changed_cols := array_append(changed_cols,'payout_method'); end if;
  if new.misc_items           is distinct from old.misc_items           then changed_cols := array_append(changed_cols,'misc_items'); end if;
  if array_length(changed_cols, 1) is not null then
    raise exception
      'payment % is locked (wise_locked_at=%); cannot change protected column(s): %',
      old.id, old.wise_locked_at, array_to_string(changed_cols, ', ')
      using errcode = 'check_violation',
            hint = 'Unlock the row first (clears wise_locked_at), then edit.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_payments_lock_warn    on payments;
drop trigger if exists trg_payments_lock_enforce on payments;
create trigger trg_payments_lock_enforce
before update on payments
for each row execute function payments_lock_enforce();

-- ============================================================================
-- Admin → company scoping (2026-06-06; full RLS enforcement, incl. worker PII)
-- Supersedes the is_admin() admin policies above with per-company scoping:
-- owners see everything, a non-owner admin sees only the companies assigned to
-- them in admin_companies (nothing until assigned). Contractor (my_worker_id)
-- policies are unchanged. See schema/migrations/2026-06-06_admin_company_scoping.sql
-- (incl. verbatim rollback). Applied to prod 2026-06-06 after JWT-sim dry-run.
-- ============================================================================
create table if not exists admin_companies (
  admin_email text not null,
  company_id  uuid not null references companies(id) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    uuid,
  primary key (admin_email, company_id)
);
create index if not exists admin_companies_email_idx on admin_companies (lower(admin_email));
alter table admin_companies enable row level security;
drop policy if exists admin_companies_owner_all on admin_companies;
create policy admin_companies_owner_all on admin_companies for all to authenticated
  using (is_owner()) with check (is_owner());
drop policy if exists admin_companies_read_self on admin_companies;
create policy admin_companies_read_self on admin_companies for select to authenticated
  using (lower(admin_email) = (select lower(email) from admin_users where user_id = auth.uid()));

-- owner OR caller assigned to this company
create or replace function is_company_admin(cid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select is_owner() or (cid is not null and exists (
    select 1 from admin_companies ac
    where ac.company_id = cid
      and lower(ac.admin_email) = (select lower(email) from admin_users where user_id = auth.uid())
  ));
$$;
-- owner OR caller assigned to a company this worker is linked to
create or replace function admin_can_see_worker(wid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select is_owner() or (wid is not null and exists (
    select 1 from worker_companies wc
    where wc.worker_id = wid and is_company_admin(wc.company_id)
  ));
$$;
-- lets a scoped admin read back a worker they just created (INSERT…RETURNING)
alter table workers add column if not exists created_by uuid default auth.uid();

-- company_id-scoped admin policies
do $$
declare t text;
begin
  foreach t in array array['companies','audit_log','pay_periods',
                           'payments','rates','time_entries','worker_companies']
  loop
    execute format('drop policy if exists %I_admin_all on %I;', t, t);
    if t = 'companies' then
      execute 'create policy companies_admin_all on companies for all to authenticated using (is_company_admin(id)) with check (is_company_admin(id));';
    else
      execute format(
        'create policy %I_admin_all on %I for all to authenticated using (is_company_admin(company_id)) with check (is_company_admin(company_id));', t, t);
    end if;
  end loop;
end$$;

-- documents: worker-scoped, NOT pure company-scoped. Onboarding uploads are
-- inserted by the contractor with a NULL company_id, so a company-only gate hides
-- them from assigned (non-owner) admins ("No document uploaded"). Gate on whether
-- the admin can see the WORKER; keep the company path for any company-tagged rows.
drop policy if exists documents_admin_all on documents;
create policy documents_admin_all on documents for all to authenticated
  using (admin_can_see_worker(worker_id) or is_company_admin(company_id))
  with check (admin_can_see_worker(worker_id) or is_company_admin(company_id));

-- workers: split so any admin may INSERT (they link to their company next), and
-- the creator can read/update the row they just inserted (created_by).
drop policy if exists workers_admin_all    on workers;
drop policy if exists workers_admin_select on workers;
drop policy if exists workers_admin_insert on workers;
drop policy if exists workers_admin_update on workers;
drop policy if exists workers_admin_delete on workers;
create policy workers_admin_select on workers for select to authenticated using (admin_can_see_worker(id) or created_by = auth.uid());
create policy workers_admin_insert on workers for insert to authenticated with check (is_admin());
create policy workers_admin_update on workers for update to authenticated using (admin_can_see_worker(id) or created_by = auth.uid()) with check (admin_can_see_worker(id) or created_by = auth.uid());
create policy workers_admin_delete on workers for delete to authenticated using (admin_can_see_worker(id));

-- worker-keyed PII tables: scope the admin reach via worker_companies
drop policy if exists contractor_logins_self on contractor_logins;
create policy contractor_logins_self on contractor_logins for select to authenticated using (auth_user_id = auth.uid() or admin_can_see_worker(worker_id));
drop policy if exists onboarding_progress_read on onboarding_progress;
create policy onboarding_progress_read on onboarding_progress for select to authenticated using (worker_id = my_worker_id() or admin_can_see_worker(worker_id));
drop policy if exists onboarding_progress_admin_write on onboarding_progress;
create policy onboarding_progress_admin_write on onboarding_progress for all to authenticated using (admin_can_see_worker(worker_id)) with check (admin_can_see_worker(worker_id));
drop policy if exists onboarding_agreements_admin_all on onboarding_agreements;
create policy onboarding_agreements_admin_all on onboarding_agreements for all to authenticated using (admin_can_see_worker(worker_id)) with check (admin_can_see_worker(worker_id));
drop policy if exists onboarding_signatures_read on onboarding_signatures;
create policy onboarding_signatures_read on onboarding_signatures for select to authenticated using (worker_id = my_worker_id() or admin_can_see_worker(worker_id));
drop policy if exists mood_self_read on mood_checkins;
create policy mood_self_read on mood_checkins for select to authenticated using (worker_id = my_worker_id() or admin_can_see_worker(worker_id));
drop policy if exists portal_notifications_read on portal_notifications;
create policy portal_notifications_read on portal_notifications for select to authenticated using (worker_id = my_worker_id() or admin_can_see_worker(worker_id));
