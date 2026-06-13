-- Prod helper functions (RLS predicates, triggers, RPCs) pulled READ-ONLY from
-- the live ABC project (pg_get_functiondef, 2026-06-12). schema.sql's policies
-- reference these but they were created ad-hoc on prod, so a fresh local stack
-- needs them BEFORE the baseline. Bodies reference tables created later —
-- disable body validation for this file (same stance as pg_dump).
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select exists (select 1 from public.admin_users where user_id = auth.uid() and role = 'owner'); $function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from admin_users where user_id = auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.is_company_admin(cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select is_owner() or (cid is not null and exists(select 1 from admin_companies ac where ac.company_id=cid and lower(ac.admin_email)=(select lower(email) from admin_users where user_id=auth.uid()))); $function$;

CREATE OR REPLACE FUNCTION public.my_admin_company_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array(
    select ac.company_id from admin_companies ac
    where lower(ac.admin_email) = (select lower(email) from admin_users where user_id = auth.uid())
  ), '{}'::uuid[]);
$function$;

CREATE OR REPLACE FUNCTION public.my_worker_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select worker_id from contractor_logins
   where auth_user_id = auth.uid() and status = 'active' limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.admin_can_see_worker(wid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select is_owner() or (wid is not null and exists(select 1 from worker_companies wc where wc.worker_id=wid and is_company_admin(wc.company_id))); $function$;

CREATE OR REPLACE FUNCTION public.is_onboarded()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from onboarding_progress
     where worker_id = my_worker_id()
       and completed_at is not null
  );
$function$;

CREATE OR REPLACE FUNCTION public.admin_lookup_auth_user(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select id from auth.users where lower(email) = lower(p_email) limit 1; $function$;

CREATE OR REPLACE FUNCTION public.admin_users_no_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin raise exception 'truncate on admin_users is not allowed'; end; $function$;

CREATE OR REPLACE FUNCTION public.admin_users_owner_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (select count(*) from public.admin_users where role = 'owner') = 0 then
    raise exception 'cannot remove or demote the last owner';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bind_pending_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record;
begin
  begin
    select * into p from public.pending_admins where lower(email) = lower(new.email) limit 1;
    if found then
      insert into public.admin_users (user_id, email, role, added_by)
        values (new.id, lower(new.email), p.role, p.added_by)
        on conflict do nothing;
      delete from public.pending_admins where lower(email) = lower(new.email);
    end if;
  exception when others then
    null;   -- never block a sign-in because of admin binding
  end;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.payments_lock_enforce()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.set_time_entry_activity(p jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  update public.time_entries t
     set activity_pct = (u->>'activity_pct')::numeric
    from jsonb_array_elements(p) u
   where t.id = (u->>'id')::uuid;
  get diagnostics n = row_count;
  return n;
end;
$function$;

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
end $function$;

CREATE OR REPLACE FUNCTION public.ack_my_tools()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update worker_tools set popup_pending=false, acked_at=now(), updated_at=now()
  where worker_id = my_worker_id();
end$function$;

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
end$function$;

CREATE OR REPLACE FUNCTION public.get_tools_status(p_worker_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  select requested, provisioned_at, popup_pending into r from worker_tools where worker_id = p_worker_id;
  if not found then return jsonb_build_object('requested', '{}'::jsonb, 'provisioned_at', null, 'popup_pending', false); end if;
  return jsonb_build_object('requested', coalesce(r.requested,'{}'::jsonb),
                            'provisioned_at', r.provisioned_at, 'popup_pending', r.popup_pending);
end$function$;

CREATE OR REPLACE FUNCTION public.set_tools_requested(p_worker_id uuid, p_requested jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  insert into worker_tools(worker_id, requested, updated_at)
  values (p_worker_id, coalesce(p_requested,'{}'::jsonb), now())
  on conflict (worker_id) do update set requested = excluded.requested, updated_at = now();
end$function$;

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
end$function$;

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
end$function$;

set check_function_bodies = on;
