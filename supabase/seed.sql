-- Local dev seed data (LOCAL stack only; applied by scripts/dev-bootstrap.mjs).
-- Deterministic UUIDs so re-running is idempotent. Two companies, a handful of
-- contractors with rates, and one open period of approved time to calculate.

-- ---------- companies ----------
insert into public.companies (id, name, status, kind) values
  ('c0000000-0000-0000-0000-000000000001', 'Ability Builders', 'active', 'client'),
  ('c0000000-0000-0000-0000-000000000002', 'Nightingale Process Mgmt', 'active', 'client')
on conflict (id) do nothing;

-- ---------- workers ----------
insert into public.workers
  (id, first_name, middle_name, last_name, status, hire_date,
   health_allowance_eligible, thirteenth_month_eligible, payout_method)
values
  ('a0000000-0000-0000-0000-000000000001', 'Maria',  'Clara',  'Santos', 'active', '2024-01-15', true,  true,  'wise'),
  ('a0000000-0000-0000-0000-000000000002', 'Jose',   null,     'Rizal',  'active', '2024-06-10', true,  true,  'wise'),
  ('a0000000-0000-0000-0000-000000000003', 'Andres', null,     'Bonifacio','active','2025-03-01', true,  false, 'gcash'),
  ('a0000000-0000-0000-0000-000000000004', 'Gabriela','M',     'Silang', 'active', '2023-09-20', true,  true,  'wise'),
  ('a0000000-0000-0000-0000-000000000005', 'Apolinario',null,  'Mabini', 'active', '2025-05-12', false, false, 'paymaya')
on conflict (id) do nothing;

-- ---------- worker_companies (links) ----------
insert into public.worker_companies
  (worker_id, company_id, contract, status, role, hubstaff_name)
values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'FT', 'active', 'Developer',   'Maria Santos'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'FT', 'active', 'Designer',    'Jose Rizal'),
  ('a0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'PT', 'active', 'QA',          'Andres Bonifacio'),
  ('a0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002', 'FT', 'active', 'Coordinator', 'Gabriela Silang'),
  ('a0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000002', 'PT', 'active', 'Support',     'Apolinario Mabini')
on conflict (company_id, worker_id) do nothing;

-- ---------- rates (effective-dated, open) ----------
insert into public.rates (worker_id, company_id, amount_php, period_basis, effective_start) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 25000.00, 'semi_monthly', '2024-01-15'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 18000.00, 'semi_monthly', '2024-06-10'),
  ('a0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 9000.00,  'semi_monthly', '2025-03-01'),
  ('a0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002', 22000.00, 'semi_monthly', '2023-09-20'),
  ('a0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000002', 11000.00, 'semi_monthly', '2025-05-12')
on conflict do nothing;

-- ---------- approved time for the 2026-06-01..15 period (Ability Builders) ----------
-- A spread of days so Calculate produces a realistic prorated batch.
insert into public.time_entries
  (id, company_id, worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval, import_batch_id, activity_pct)
select
  gen_random_uuid(),
  'c0000000-0000-0000-0000-000000000001',
  w.id, w.nm, d::date, w.secs, 0, 'approved',
  'b0000000-0000-0000-0000-000000000001',
  -- deterministic day-varied activity %, ~60–95, so the portal Activity chart has a real trend
  60 + ((extract(doy from d)::int * 13) % 36)
from (values
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Maria Santos',     28800),
  ('a0000000-0000-0000-0000-000000000002'::uuid, 'Jose Rizal',       28800),
  ('a0000000-0000-0000-0000-000000000003'::uuid, 'Andres Bonifacio', 14400)
) as w(id, nm, secs)
cross join generate_series('2026-06-01'::date, '2026-06-12'::date, interval '1 day') as d
where extract(isodow from d) < 6  -- weekdays only
on conflict (company_id, source_name, work_date) do nothing;

-- ---------- portal settings: self-service editable allow-list ----------
-- Mirrors shared prod's portal_settings.editable_fields exactly (the FULL
-- self-service set, incl. names + date_of_birth + all "About me" fields). Without
-- this row, editable_fields defaults to '[]' so the contractor portal renders
-- every profile field read-only ("editing turned off") — which reads as an
-- "incomplete" profile. Server-side writes are still hard-capped to SAFE_FIELDS.
insert into public.portal_settings (id, editable_fields) values (1, '[
  "first_name","middle_name","last_name",
  "mobile","ph_address","permanent_address","address_landmark","postal_code","date_of_birth",
  "emergency_name","emergency_relationship","emergency_mobile",
  "marital_status","education_level","course","year_graduated","school",
  "gcash","paymaya","paypal","wise_tag",
  "nickname","favorite_color","favorite_food","tshirt_size","shoe_size","hobbies","motto"
]'::jsonb)
on conflict (id) do update set editable_fields = excluded.editable_fields;

-- ---------- prior activity history (Maria) so the portal Activity chart scrolls ----------
-- ~2 months of approved weekday entries with day-varied activity %, before the active
-- period above. The portal Home Activity chart renders the FULL history (no cap) and
-- scrolls left/right, so this gives it something real to scroll through.
insert into public.time_entries
  (id, company_id, worker_id, source_name, work_date, tracked_seconds, pto_seconds, approval, import_batch_id, activity_pct)
select
  gen_random_uuid(), 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
  'Maria Santos', d::date, 28800, 0, 'approved', 'b0000000-0000-0000-0000-000000000001',
  60 + ((extract(doy from d)::int * 13) % 36)
from generate_series('2026-04-01'::date, '2026-05-29'::date, interval '1 day') as d
where extract(isodow from d) < 6  -- weekdays only
on conflict (company_id, source_name, work_date) do nothing;

-- Lower a few recent days into the navy (35–59) and amber (<35) activity bands so
-- the chart's color coding (≥60 green · 35–59 navy · <35 amber) is all visible.
update public.time_entries t set activity_pct = v.pct
from (values
  ('2026-06-03'::date, 54),  -- navy
  ('2026-06-09'::date, 46),  -- navy
  ('2026-06-10'::date, 30),  -- amber
  ('2026-06-11'::date, 23)   -- amber
) as v(d, pct)
where t.worker_id = 'a0000000-0000-0000-0000-000000000001' and t.work_date = v.d;
