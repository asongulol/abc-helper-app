-- ============================================================================
-- Per-session billing
-- ----------------------------------------------------------------------------
-- Adds a flat-fee-per-session billing path alongside the existing hourly one.
--   * service_sessions  — one row per visit/session, recorded directly against
--     the CLIENT company (unlike time_entries, whose company_id is the employer
--     and which is re-attributed to a client via worker_companies). Approval
--     mirrors time_entries and reuses public.approval_status.
--   * worker_companies.session_rate_usd — the per-worker-per-client flat fee
--     (mirrors bill_rate_usd: nullable, null/0 ⇒ a $0 line).
--   * invoice_lines.kind / sessions_count / session_rate_usd — lets a single
--     client invoice carry both hourly and session lines. Existing rows default
--     to kind='hourly'; invoices_one_live_per_period and snapshot semantics are
--     unchanged.
-- ============================================================================

-- 1. Per-worker-per-client flat session fee.
alter table public.worker_companies
  add column if not exists session_rate_usd numeric(12,2);

-- 2. Session/visit log.
create table if not exists public.service_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  worker_id uuid references public.workers (id) on delete set null,
  session_date date not null,
  session_type text,
  units integer not null default 1 check (units >= 0),
  case_ref text,
  notes text,
  approval public.approval_status not null default 'pending',
  approved_by uuid,
  approved_at timestamp with time zone,
  import_batch_id uuid,
  external_ref text,
  created_by uuid default auth.uid(),
  created_at timestamp with time zone not null default now()
);

comment on column public.service_sessions.company_id is
  'The CLIENT being billed (companies.kind=''client''). Unlike time_entries.company_id, which is always the employer.';

alter table public.service_sessions owner to postgres;

-- Idempotent CSV imports only; manual entry leaves external_ref null (multiple
-- visits per worker per day are legal, so there is no natural-key unique).
create unique index if not exists service_sessions_external_ref_uniq
  on public.service_sessions (company_id, external_ref) where external_ref is not null;

-- The invoice-window query and the management/batch views.
create index if not exists service_sessions_company_date_idx
  on public.service_sessions (company_id, session_date);
create index if not exists service_sessions_worker_idx
  on public.service_sessions (worker_id);
create index if not exists service_sessions_import_batch_idx
  on public.service_sessions (import_batch_id) where import_batch_id is not null;

-- RLS: owner or an admin of the (client) company — same shape as time_entries /
-- invoices. my_admin_company_ids() already returns client company ids.
alter table public.service_sessions enable row level security;

create policy "service_sessions_admin_all" on public.service_sessions
  to authenticated
  using (
    (select public.is_owner()) or (company_id in (select unnest(public.my_admin_company_ids())))
  )
  with check (
    (select public.is_owner()) or (company_id in (select unnest(public.my_admin_company_ids())))
  );

grant all on table public.service_sessions to anon;
grant all on table public.service_sessions to authenticated;
grant all on table public.service_sessions to service_role;

-- 3. Both line kinds on one invoice. amount_usd stays authoritative + snapshotted;
-- hourly lines keep worked_hours/bill_rate_usd (session cols null) and vice versa.
alter table public.invoice_lines
  add column if not exists kind text not null default 'hourly',
  add column if not exists sessions_count integer,
  add column if not exists session_rate_usd numeric(12,2);

alter table public.invoice_lines drop constraint if exists invoice_lines_kind_chk;
alter table public.invoice_lines
  add constraint invoice_lines_kind_chk check (kind in ('hourly', 'session'));

-- ROLLBACK:
--   alter table public.invoice_lines drop constraint if exists invoice_lines_kind_chk;
--   alter table public.invoice_lines drop column if exists session_rate_usd;
--   alter table public.invoice_lines drop column if exists sessions_count;
--   alter table public.invoice_lines drop column if exists kind;
--   drop table if exists public.service_sessions;
--   alter table public.worker_companies drop column if exists session_rate_usd;
