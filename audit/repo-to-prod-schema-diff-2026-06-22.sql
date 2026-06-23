create extension if not exists "pg_net" with schema "public";

drop trigger if exists "audit_log_no_mutate" on "public"."audit_log";

drop trigger if exists "audit_log_no_truncate" on "public"."audit_log";

drop trigger if exists "trg_onboarding_signatures_protect" on "public"."onboarding_signatures";

drop trigger if exists "trg_payments_period_open_enforce_ins" on "public"."payments";

drop trigger if exists "trg_payments_period_open_enforce_upd" on "public"."payments";

drop policy "audit_log_admin_insert" on "public"."audit_log";

drop policy "audit_log_admin_read" on "public"."audit_log";

drop policy "coverage_targets_admin_all" on "public"."coverage_targets";

drop policy "pay_periods_contractor_read" on "public"."pay_periods";

revoke delete on table "public"."admin_users" from "anon";

revoke insert on table "public"."admin_users" from "anon";

revoke references on table "public"."admin_users" from "anon";

revoke truncate on table "public"."admin_users" from "anon";

revoke update on table "public"."admin_users" from "anon";

revoke delete on table "public"."admin_users" from "authenticated";

revoke insert on table "public"."admin_users" from "authenticated";

revoke references on table "public"."admin_users" from "authenticated";

revoke truncate on table "public"."admin_users" from "authenticated";

revoke update on table "public"."admin_users" from "authenticated";

revoke delete on table "public"."app_secrets" from "anon";

revoke insert on table "public"."app_secrets" from "anon";

revoke references on table "public"."app_secrets" from "anon";

revoke select on table "public"."app_secrets" from "anon";

revoke trigger on table "public"."app_secrets" from "anon";

revoke truncate on table "public"."app_secrets" from "anon";

revoke update on table "public"."app_secrets" from "anon";

revoke delete on table "public"."app_secrets" from "authenticated";

revoke insert on table "public"."app_secrets" from "authenticated";

revoke references on table "public"."app_secrets" from "authenticated";

revoke select on table "public"."app_secrets" from "authenticated";

revoke trigger on table "public"."app_secrets" from "authenticated";

revoke truncate on table "public"."app_secrets" from "authenticated";

revoke update on table "public"."app_secrets" from "authenticated";

revoke delete on table "public"."coverage_targets" from "anon";

revoke insert on table "public"."coverage_targets" from "anon";

revoke references on table "public"."coverage_targets" from "anon";

revoke select on table "public"."coverage_targets" from "anon";

revoke trigger on table "public"."coverage_targets" from "anon";

revoke truncate on table "public"."coverage_targets" from "anon";

revoke update on table "public"."coverage_targets" from "anon";

revoke delete on table "public"."coverage_targets" from "authenticated";

revoke insert on table "public"."coverage_targets" from "authenticated";

revoke references on table "public"."coverage_targets" from "authenticated";

revoke select on table "public"."coverage_targets" from "authenticated";

revoke trigger on table "public"."coverage_targets" from "authenticated";

revoke truncate on table "public"."coverage_targets" from "authenticated";

revoke update on table "public"."coverage_targets" from "authenticated";

revoke delete on table "public"."coverage_targets" from "service_role";

revoke insert on table "public"."coverage_targets" from "service_role";

revoke references on table "public"."coverage_targets" from "service_role";

revoke select on table "public"."coverage_targets" from "service_role";

revoke trigger on table "public"."coverage_targets" from "service_role";

revoke truncate on table "public"."coverage_targets" from "service_role";

revoke update on table "public"."coverage_targets" from "service_role";

revoke delete on table "public"."pending_admins" from "anon";

revoke insert on table "public"."pending_admins" from "anon";

revoke truncate on table "public"."pending_admins" from "anon";

revoke update on table "public"."pending_admins" from "anon";

revoke delete on table "public"."pending_admins" from "authenticated";

revoke insert on table "public"."pending_admins" from "authenticated";

revoke truncate on table "public"."pending_admins" from "authenticated";

revoke update on table "public"."pending_admins" from "authenticated";

alter table "public"."coverage_targets" drop constraint "coverage_targets_check";

alter table "public"."coverage_targets" drop constraint "coverage_targets_company_id_fkey";

alter table "public"."coverage_targets" drop constraint "coverage_targets_period_kind_check";

alter table "public"."coverage_targets" drop constraint "coverage_targets_target_hours_check";

alter table "public"."coverage_targets" drop constraint "coverage_targets_target_sessions_check";

alter table "public"."coverage_targets" drop constraint "coverage_targets_worker_id_fkey";

alter table "public"."invoice_lines" drop constraint "invoice_lines_amounts_nonneg";

alter table "public"."invoices" drop constraint "invoices_amount_received_nonneg";

alter table "public"."invoices" drop constraint "invoices_amounts_nonneg";

alter table "public"."invoices" drop constraint "invoices_period_order";

alter table "public"."invoices" drop constraint "invoices_status_check";

alter table "public"."payments" drop constraint "payments_amounts_nonneg";

alter table "public"."payments" drop constraint "payments_misc_items_valid";

alter table "public"."rates" drop constraint "rates_amount_nonneg";

alter table "public"."worker_companies" drop constraint "worker_companies_rates_nonneg";

drop function if exists "public"."audit_log_append_only"();

drop function if exists "public"."my_tools_pending"();

drop function if exists "public"."onboarding_signatures_protect"();

drop function if exists "public"."payments_misc_items_ok"(items jsonb);

drop function if exists "public"."payments_period_open_enforce"();

drop function if exists "public"."reveal_worker_tools"(p_worker_id uuid);

drop function if exists "public"."worker_has_payment_in_period"(pid uuid);

alter table "public"."coverage_targets" drop constraint "coverage_targets_pkey";

drop index if exists "public"."coverage_targets_company_idx";

drop index if exists "public"."coverage_targets_one_open";

drop index if exists "public"."coverage_targets_pkey";

drop index if exists "public"."coverage_targets_worker_idx";

drop index if exists "public"."documents_fileless_slot_uniq";

drop index if exists "public"."invoice_lines_worker_id_idx";

drop index if exists "public"."invoices_invoice_no_unique";

drop index if exists "public"."payments_worker_id_idx";

drop index if exists "public"."rates_one_open_per_worker_company";

drop index if exists "public"."service_sessions_external_ref_uniq";

drop table "public"."coverage_targets";

alter table "public"."worker_companies" alter column "contract" drop default;

alter type "public"."contract_type" rename to "contract_type__old_version_to_be_dropped";

create type "public"."contract_type" as enum ('FT', 'PT', 'PH', 'PS', 'PHS');

alter table "public"."worker_companies" alter column contract type "public"."contract_type" using contract::text::"public"."contract_type";

alter table "public"."worker_companies" alter column "contract" set default 'FT'::public.contract_type;

drop type "public"."contract_type__old_version_to_be_dropped";

alter table "public"."companies" add column "api_payouts_enabled" boolean not null default false;

alter table "public"."documents" add column "defer_until" date;

alter table "public"."invoices" drop column "amount_received_usd";

alter table "public"."invoices" drop column "payment_ref";

alter table "public"."invoices" drop column "received_on";

alter table "public"."payments" add column "contract" text;

alter table "public"."payments" add column "fund_error" text;

alter table "public"."payments" add column "funded_at" timestamp with time zone;

alter table "public"."payments" add column "funded_by" text;

alter table "public"."payments" add column "pay_basis" text;

alter table "public"."payments" add column "units" numeric(12,2);

alter table "public"."worker_companies" add column "pay_basis" text;

alter table "public"."worker_tools" drop column "revealed_at";

CREATE INDEX payments_unfunded_drafts ON public.payments USING btree (pay_period_id) WHERE ((wise_transfer_id IS NOT NULL) AND (funded_at IS NULL) AND (status <> 'reconciled'::public.payment_status));

CREATE UNIQUE INDEX service_sessions_external_ref_unq ON public.service_sessions USING btree (company_id, external_ref) WHERE (external_ref IS NOT NULL);

alter table "public"."payments" add constraint "payments_misc_items_array" CHECK ((jsonb_typeof(misc_items) = 'array'::text)) not valid;

alter table "public"."payments" validate constraint "payments_misc_items_array";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.decrypt_worker_tools(p_worker_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; e text;
begin
  select enc into e from worker_tools where worker_id = p_worker_id;
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb;
end$function$
;

CREATE OR REPLACE FUNCTION public.my_clients()
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.name
  from worker_companies wc
  join companies c on c.id = wc.company_id
  where wc.worker_id = public.my_worker_id()
    and wc.status = 'active'
    and c.kind = 'client'
    and c.status = 'active'
  order by c.name;
$function$
;

CREATE OR REPLACE FUNCTION public.allocate_invoice_no(p_year integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  select count(*) + 1 into n from public.invoices where extract(year from created_at) = p_year and status <> 'void';
  return p_year::text || '-' || lpad(n::text, 4, '0');
end $function$
;

CREATE OR REPLACE FUNCTION public.get_my_tools()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; e text; pend boolean;
begin
  select enc, popup_pending into e, pend from worker_tools where worker_id = my_worker_id();
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return jsonb_build_object('popup_pending', pend,
    'creds', extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb);
end$function$
;

CREATE OR REPLACE FUNCTION public.payments_lock_enforce()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare changed_cols text[] := '{}';
begin
  if old.wise_locked_at is null then return new; end if;
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
  if new.shortfall_php        is distinct from old.shortfall_php        then changed_cols := array_append(changed_cols,'shortfall_php'); end if;
  if new.net_php              is distinct from old.net_php              then changed_cols := array_append(changed_cols,'net_php'); end if;
  if new.original_net_php     is distinct from old.original_net_php     then changed_cols := array_append(changed_cols,'original_net_php'); end if;
  if new.payout_currency      is distinct from old.payout_currency      then changed_cols := array_append(changed_cols,'payout_currency'); end if;
  if new.payout_amount        is distinct from old.payout_amount        then changed_cols := array_append(changed_cols,'payout_amount'); end if;
  if new.payout_method        is distinct from old.payout_method        then changed_cols := array_append(changed_cols,'payout_method'); end if;
  if new.misc_items           is distinct from old.misc_items           then changed_cols := array_append(changed_cols,'misc_items'); end if;
  if array_length(changed_cols, 1) is not null then
    raise exception 'payment % is locked (wise_locked_at=%); cannot change protected column(s): %',
      old.id, old.wise_locked_at, array_to_string(changed_cols, ', ')
      using errcode = 'check_violation', hint = 'Unlock the row first (clears wise_locked_at), then edit.';
  end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.set_worker_tools(p_worker_id uuid, p_creds jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text;
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  select value into k from app_secrets where key='tools_enc_key';
  if k is null then raise exception 'tools_enc_key not set'; end if;
  insert into worker_tools(worker_id, enc, provisioned_at, popup_pending, acked_at, updated_at)
  values (p_worker_id, extensions.armor(extensions.pgp_sym_encrypt(p_creds::text, k)), now(), true, null, now())
  on conflict (worker_id) do update
    set enc=excluded.enc, provisioned_at=now(), popup_pending=true, acked_at=null, updated_at=now();
end$function$
;


  create policy "audit_log_admin_all"
  on "public"."audit_log"
  as permissive
  for all
  to authenticated
using (public.is_company_admin(company_id))
with check (public.is_company_admin(company_id));



  create policy "service_sessions_contractor_delete"
  on "public"."service_sessions"
  as permissive
  for delete
  to authenticated
using (((worker_id = public.my_worker_id()) AND (approval = 'pending'::public.approval_status)));



  create policy "service_sessions_contractor_update"
  on "public"."service_sessions"
  as permissive
  for update
  to authenticated
using (((worker_id = public.my_worker_id()) AND (approval = 'pending'::public.approval_status)))
with check (((worker_id = public.my_worker_id()) AND (approval = 'pending'::public.approval_status) AND (company_id IN ( SELECT my_clients.id
   FROM public.my_clients() my_clients(id, name)))));



  create policy "pay_periods_contractor_read"
  on "public"."pay_periods"
  as permissive
  for select
  to authenticated
using (((( SELECT public.my_worker_id() AS my_worker_id) IS NOT NULL) AND ( SELECT public.is_onboarded() AS is_onboarded)));




