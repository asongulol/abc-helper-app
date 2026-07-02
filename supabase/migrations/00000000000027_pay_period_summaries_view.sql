-- Aggregated pay-period summaries for the batch list + ⌘K palette.
--
-- fetchPeriodSummaries previously ran TWO queries on every admin page load
-- (the layout builds the palette from it): all pay_periods, then EVERY
-- payments row for every period (select pay_period_id, net_php), counted and
-- summed in JS. That transfer grows linearly with payroll history forever.
-- This view pushes the aggregation into Postgres: one round-trip returning
-- one row per period.
--
-- security_invoker: the view runs with the CALLER's privileges, so the
-- existing pay_periods / payments RLS policies (company scoping) apply
-- unchanged — no tenancy weakening.
--
-- Money: sum(net_php) over numeric(12,2) is exact; the app converts the total
-- to integer centavos the same way it converted each row before.
--
-- ADDITIVE + IDEMPOTENT. Do NOT `db push` to shared prod — apply via the SQL
-- Editor / MCP, then record "00000000000027" in supabase/prod-applied.json.

create or replace view public.pay_period_summaries
with (security_invoker = true) as
select
  pp.id,
  pp.company_id,
  pp.state,
  pp.kind,
  pp.period_start,
  pp.period_end,
  pp.pay_date,
  pp.locked_at,
  count(p.id)::int as contractor_count,
  coalesce(sum(p.net_php), 0)::numeric(14,2) as total_net_php
from public.pay_periods pp
left join public.payments p on p.pay_period_id = pp.id
group by pp.id;

grant select on public.pay_period_summaries to anon, authenticated, service_role;

-- ROLLBACK: drop view public.pay_period_summaries;
