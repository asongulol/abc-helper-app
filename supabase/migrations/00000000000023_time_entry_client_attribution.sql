-- ============================================================================
-- Hours → client attribution (Phase 2b)
-- ----------------------------------------------------------------------------
-- Clients are invoiced on ACTUAL hours worked for THEM, and a contractor may
-- serve multiple clients. `time_entries.client_company_id` records the CLIENT a
-- block of hours was worked for (the invoicing target), set explicitly via
-- manual entry or (future) the Hubstaff project→client map.
--
-- NULL = unattributed. Invoicing resolves NULL at read time: a contractor with
-- exactly ONE active client bills their hours to that client (today's reality);
-- a multi-client contractor's NULL hours bill to NOBODY and are flagged, so the
-- same hours can never bill to two clients (the double-bill guard).
--
-- Pay is unaffected — the ratio model sums a contractor's hours across all
-- clients (fetchApprovedTime groups by worker, ignores this column).
--
-- ⚠️ Local/CI only — prod copy hand-applied via the Dashboard (disjoint history).
-- ADDITIVE + IDEMPOTENT.
-- ============================================================================

alter table public.time_entries
  add column if not exists client_company_id uuid references public.companies (id);

comment on column public.time_entries.client_company_id is
  'CLIENT these hours were worked for (invoicing attribution). NULL = unattributed → resolved at invoice time to the contractor''s single client, or flagged when multi-client. Set via manual entry or the Hubstaff project→client map.';

create index if not exists time_entries_client_company_idx
  on public.time_entries (client_company_id, work_date)
  where client_company_id is not null;

-- ROLLBACK:
--   drop index if exists public.time_entries_client_company_idx;
--   alter table public.time_entries drop column if exists client_company_id;
