


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."agreement_kind" AS ENUM (
    'ic_agreement',
    'non_compete',
    'confidentiality_nda',
    'baa'
);


ALTER TYPE "public"."agreement_kind" OWNER TO "postgres";


CREATE TYPE "public"."approval_status" AS ENUM (
    'pending',
    'approved',
    'rejected'
);


ALTER TYPE "public"."approval_status" OWNER TO "postgres";


CREATE TYPE "public"."company_status" AS ENUM (
    'active',
    'inactive'
);


ALTER TYPE "public"."company_status" OWNER TO "postgres";


CREATE TYPE "public"."contract_type" AS ENUM (
    'FT',
    'PT'
);


ALTER TYPE "public"."contract_type" OWNER TO "postgres";


CREATE TYPE "public"."document_kind" AS ENUM (
    'ic_agreement',
    'w8ben',
    'gov_id',
    'other',
    'resume',
    'diploma',
    'nbi_clearance'
);


ALTER TYPE "public"."document_kind" OWNER TO "postgres";


CREATE TYPE "public"."onboarding_stage" AS ENUM (
    'stage1_sign',
    'stage2_profile',
    'stage3_docs',
    'complete'
);


ALTER TYPE "public"."onboarding_stage" OWNER TO "postgres";


CREATE TYPE "public"."pay_period_state" AS ENUM (
    'open',
    'locked',
    'paid'
);


ALTER TYPE "public"."pay_period_state" OWNER TO "postgres";


CREATE TYPE "public"."payment_status" AS ENUM (
    'draft',
    'queued',
    'sent',
    'failed',
    'reconciled'
);


ALTER TYPE "public"."payment_status" OWNER TO "postgres";


CREATE TYPE "public"."payout_method" AS ENUM (
    'wise',
    'bpi',
    'gcash',
    'paymaya',
    'paypal'
);


ALTER TYPE "public"."payout_method" OWNER TO "postgres";


CREATE TYPE "public"."portal_notification_kind" AS ENUM (
    'stage_complete',
    'upload_received',
    'doc_approved',
    'doc_needs_replacement',
    'onboarding_complete',
    'onboarding_stalled'
);


ALTER TYPE "public"."portal_notification_kind" OWNER TO "postgres";


CREATE TYPE "public"."review_status" AS ENUM (
    'pending',
    'approved',
    'needs_replacement',
    'waived',
    'deferred'
);


ALTER TYPE "public"."review_status" OWNER TO "postgres";


CREATE TYPE "public"."signature_method" AS ENUM (
    'typed',
    'drawn'
);


ALTER TYPE "public"."signature_method" OWNER TO "postgres";


CREATE TYPE "public"."signature_status" AS ENUM (
    'signed',
    'superseded',
    'disputed'
);


ALTER TYPE "public"."signature_status" OWNER TO "postgres";


CREATE TYPE "public"."worker_status" AS ENUM (
    'active',
    'inactive',
    'ended'
);


ALTER TYPE "public"."worker_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ack_my_tools"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update worker_tools set popup_pending=false, acked_at=now(), updated_at=now()
  where worker_id = my_worker_id();
end$$;


ALTER FUNCTION "public"."ack_my_tools"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_can_see_worker"("wid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select is_owner() or (wid is not null and exists(select 1 from worker_companies wc where wc.worker_id=wid and is_company_admin(wc.company_id))); $$;


ALTER FUNCTION "public"."admin_can_see_worker"("wid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_lookup_auth_user"("p_email" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select id from auth.users where lower(email) = lower(p_email) limit 1; $$;


ALTER FUNCTION "public"."admin_lookup_auth_user"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_users_no_truncate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ begin raise exception 'truncate on admin_users is not allowed'; end; $$;


ALTER FUNCTION "public"."admin_users_no_truncate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_users_owner_check"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if (select count(*) from public.admin_users where role = 'owner') = 0 then
    raise exception 'cannot remove or demote the last owner';
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."admin_users_owner_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."allocate_invoice_no"("p_year" integer) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n int;
begin
  select count(*) + 1 into n from public.invoices where extract(year from created_at) = p_year and status <> 'void';
  return p_year::text || '-' || lpad(n::text, 4, '0');
end $$;


ALTER FUNCTION "public"."allocate_invoice_no"("p_year" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bind_pending_admin"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."bind_pending_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decrypt_worker_tools"("p_worker_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare k text; e text;
begin
  select enc into e from worker_tools where worker_id = p_worker_id;
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb;
end$$;


ALTER FUNCTION "public"."decrypt_worker_tools"("p_worker_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_tools"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare k text; e text; pend boolean;
begin
  select enc, popup_pending into e, pend from worker_tools where worker_id = my_worker_id();
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return jsonb_build_object('popup_pending', pend,
    'creds', extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb);
end$$;


ALTER FUNCTION "public"."get_my_tools"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tools_status"("p_worker_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare r record;
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  select requested, provisioned_at, popup_pending into r from worker_tools where worker_id = p_worker_id;
  if not found then return jsonb_build_object('requested', '{}'::jsonb, 'provisioned_at', null, 'popup_pending', false); end if;
  return jsonb_build_object('requested', coalesce(r.requested,'{}'::jsonb),
                            'provisioned_at', r.provisioned_at, 'popup_pending', r.popup_pending);
end$$;


ALTER FUNCTION "public"."get_tools_status"("p_worker_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_company_admin"("cid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select is_owner() or (cid is not null and exists(select 1 from admin_companies ac where ac.company_id=cid and lower(ac.admin_email)=(select lower(email) from admin_users where user_id=auth.uid()))); $$;


ALTER FUNCTION "public"."is_company_admin"("cid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_onboarded"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from onboarding_progress
     where worker_id = my_worker_id()
       and completed_at is not null
  );
$$;


ALTER FUNCTION "public"."is_onboarded"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select exists (select 1 from public.admin_users where user_id = auth.uid() and role = 'owner'); $$;


ALTER FUNCTION "public"."is_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_admin_company_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array(
    select ac.company_id from admin_companies ac
    where lower(ac.admin_email) = (select lower(email) from admin_users where user_id = auth.uid())
  ), '{}'::uuid[]);
$$;


ALTER FUNCTION "public"."my_admin_company_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_worker_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select worker_id from contractor_logins
   where auth_user_id = auth.uid() and status = 'active' limit 1;
$$;


ALTER FUNCTION "public"."my_worker_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payments_lock_enforce"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."payments_lock_enforce"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_time_entry_activity"("p" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n integer;
begin
  update public.time_entries t
     set activity_pct = (u->>'activity_pct')::numeric
    from jsonb_array_elements(p) u
   where t.id = (u->>'id')::uuid;
  get diagnostics n = row_count;
  return n;
end;
$$;


ALTER FUNCTION "public"."set_time_entry_activity"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_tools_requested"("p_worker_id" "uuid", "p_requested" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  insert into worker_tools(worker_id, requested, updated_at)
  values (p_worker_id, coalesce(p_requested,'{}'::jsonb), now())
  on conflict (worker_id) do update set requested = excluded.requested, updated_at = now();
end$$;


ALTER FUNCTION "public"."set_tools_requested"("p_worker_id" "uuid", "p_requested" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_worker_tools"("p_worker_id" "uuid", "p_creds" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare k text;
begin
  if not admin_can_see_worker(p_worker_id) then raise exception 'not authorized'; end if;
  select value into k from app_secrets where key='tools_enc_key';
  if k is null then raise exception 'tools_enc_key not set'; end if;
  insert into worker_tools(worker_id, enc, provisioned_at, popup_pending, acked_at, updated_at)
  values (p_worker_id, extensions.armor(extensions.pgp_sym_encrypt(p_creds::text, k)), now(), true, null, now())
  on conflict (worker_id) do update
    set enc=excluded.enc, provisioned_at=now(), popup_pending=true, acked_at=null, updated_at=now();
end$$;


ALTER FUNCTION "public"."set_worker_tools"("p_worker_id" "uuid", "p_creds" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_companies" (
    "admin_email" "text" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid"
);


ALTER TABLE "public"."admin_companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid",
    "name" "text",
    "can_countersign" boolean DEFAULT true NOT NULL,
    CONSTRAINT "admin_users_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."admin_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agreement_templates" (
    "kind" "public"."agreement_kind" NOT NULL,
    "title" "text" NOT NULL,
    "version" "text" DEFAULT '1.0'::"text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agreement_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."announcements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "author" "text",
    "active" boolean DEFAULT true NOT NULL,
    "published_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."announcements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_tokens" (
    "provider" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "access_token" "text",
    "access_expires_at" timestamp with time zone
);


ALTER TABLE "public"."api_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_secrets" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid",
    "actor" "text",
    "action" "text" NOT NULL,
    "entity" "text",
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "status" "public"."company_status" DEFAULT 'active'::"public"."company_status" NOT NULL,
    "hubstaff_org_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'client'::"text" NOT NULL,
    "address" "text",
    "phone" "text",
    "website" "text",
    "contacts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "tax_id" "text",
    CONSTRAINT "companies_kind_chk" CHECK (("kind" = ANY (ARRAY['employer'::"text", 'client'::"text"])))
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."companies"."contacts" IS 'Array of contact objects: {first_name,last_name,title,email,mobile,extension,fax}';



COMMENT ON COLUMN "public"."companies"."tax_id" IS 'Company tax identifier (e.g. US EIN, PH TIN). Free text.';



CREATE TABLE IF NOT EXISTS "public"."contractor_logins" (
    "worker_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "email" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_login_at" timestamp with time zone
);


ALTER TABLE "public"."contractor_logins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "company_id" "uuid",
    "kind" "public"."document_kind" NOT NULL,
    "title" "text",
    "storage_path" "text",
    "signed_on" "date",
    "expires_on" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "review_status" "public"."review_status" DEFAULT 'pending'::"public"."review_status" NOT NULL,
    "review_reason" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "issued_on" "date",
    "mime_type" "text",
    "file_size_bytes" bigint,
    "side" "text"
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hubstaff_projects" (
    "hubstaff_project_id" bigint NOT NULL,
    "company_id" "uuid" NOT NULL,
    "name" "text",
    "org_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hubstaff_projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "worker_id" "uuid",
    "worker_name" "text",
    "position" "text",
    "worked_hours" numeric(10,2) DEFAULT 0 NOT NULL,
    "bill_rate_usd" numeric(12,2) DEFAULT 0 NOT NULL,
    "amount_usd" numeric(14,2) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."invoice_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "pay_date" "date",
    "invoice_no" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "subtotal_usd" numeric(14,2) DEFAULT 0 NOT NULL,
    "total_usd" numeric(14,2) DEFAULT 0 NOT NULL,
    "markup_pct" numeric(6,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mood_checkins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid",
    "mood" integer,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text"
);


ALTER TABLE "public"."mood_checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_agreements" (
    "worker_id" "uuid" NOT NULL,
    "agreement_kind" "public"."agreement_kind" NOT NULL,
    "f_rate" "text",
    "f_start_date" "date",
    "f_position" "text",
    "prepared_by" "uuid",
    "prepared_at" timestamp with time zone,
    "countersigner_user_id" "uuid",
    "countersigned_by" "uuid",
    "countersigned_name" "text",
    "countersign_method" "text",
    "countersign_data" "text",
    "countersigned_at" timestamp with time zone,
    "countersign_ip" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "countersigner_name" "text",
    "addendum_type" "text",
    "addendum_text" "text",
    "f_company_name" "text",
    "f_employment_type" "text",
    "f_schedule" "text",
    "f_hours_per_week" numeric
);


ALTER TABLE "public"."onboarding_agreements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_progress" (
    "worker_id" "uuid" NOT NULL,
    "current_stage" "public"."onboarding_stage" DEFAULT 'stage1_sign'::"public"."onboarding_stage" NOT NULL,
    "stage1_last_kind" "public"."agreement_kind",
    "stage2_last_tab" "text",
    "stage1_complete" boolean DEFAULT false NOT NULL,
    "stage2_complete" boolean DEFAULT false NOT NULL,
    "stage3_complete" boolean DEFAULT false NOT NULL,
    "name_mismatch_flag" boolean DEFAULT false NOT NULL,
    "stalled" boolean DEFAULT false NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "extra_documents" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."onboarding_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "stage_at_send" "public"."onboarding_stage" NOT NULL,
    "reminder_day" integer NOT NULL,
    "channel" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."onboarding_reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "agreement_kind" "public"."agreement_kind" NOT NULL,
    "doc_version" "text" NOT NULL,
    "doc_sha256" "text",
    "signed_legal_name" "text" NOT NULL,
    "signature_method" "public"."signature_method" NOT NULL,
    "signature_data" "text",
    "scrolled_to_end" boolean DEFAULT false NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "device_fingerprint" "text",
    "status" "public"."signature_status" DEFAULT 'signed'::"public"."signature_status" NOT NULL,
    "signed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signed_date" "date"
);


ALTER TABLE "public"."onboarding_signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pay_periods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "pay_date" "date",
    "state" "public"."pay_period_state" DEFAULT 'open'::"public"."pay_period_state" NOT NULL,
    "expected_hours_ft" numeric(6,2) DEFAULT 80 NOT NULL,
    "expected_hours_pt" numeric(6,2) DEFAULT 40 NOT NULL,
    "locked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pay_periods_check" CHECK (("period_end" >= "period_start"))
);


ALTER TABLE "public"."pay_periods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "pay_period_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "expected_hours" numeric(6,2),
    "worked_hours" numeric(8,4),
    "performance_ratio" numeric(6,4),
    "rate_php" numeric(12,2),
    "gross_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "health_allowance_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "thirteenth_month_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "deduction_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "net_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "fx_rate" numeric(14,6),
    "payout_currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "payout_amount" numeric(12,2),
    "payout_method" "public"."payout_method",
    "wise_transfer_id" "text",
    "status" "public"."payment_status" DEFAULT 'draft'::"public"."payment_status" NOT NULL,
    "paid_at" timestamp with time zone,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pdd_lunch_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "bonus_php" numeric(12,2) DEFAULT 0 NOT NULL,
    "wise_dates" "jsonb",
    "wise_locked_at" timestamp with time zone,
    "original_net_php" numeric(12,2),
    "misc_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "payments_misc_items_array" CHECK (("jsonb_typeof"("misc_items") = 'array'::"text"))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_admins" (
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "added_by" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pending_admins_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."pending_admins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "kind" "public"."portal_notification_kind" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dismissed_at" timestamp with time zone
);


ALTER TABLE "public"."portal_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_settings" (
    "id" integer DEFAULT 1 NOT NULL,
    "editable_fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "onboarding_config" "jsonb" DEFAULT '{"documents": [{"kind": "resume", "title": "Resume / CV", "required": true}, {"kind": "diploma", "title": "Diploma or Transcript of Records", "required": true}, {"kind": "nbi_clearance", "title": "NBI Clearance", "required": true, "freshness_months": 6}, {"kind": "gov_id", "sides": ["front", "back"], "title": "Government-issued ID or Passport", "required": true}], "agreements": [{"kind": "ic_agreement", "order": 1, "title": "Independent Contractor Agreement", "version": "1.0", "required": true}, {"kind": "non_compete", "order": 2, "title": "Non-Compete Agreement", "version": "1.0", "required": true}, {"kind": "confidentiality_nda", "order": 3, "title": "Confidentiality / Non-Disclosure Agreement", "version": "1.0", "required": true}, {"kind": "baa", "order": 4, "title": "Business Associate Agreement (BAA)", "version": "1.0", "required": true}], "profile_tabs": ["contact", "personal", "payout", "about"], "onboarding_enabled": false}'::"jsonb" NOT NULL,
    CONSTRAINT "portal_settings_singleton" CHECK (("id" = 1))
);


ALTER TABLE "public"."portal_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "amount_php" numeric(12,2) NOT NULL,
    "period_basis" "text" DEFAULT 'semi_monthly'::"text" NOT NULL,
    "effective_start" "date" NOT NULL,
    "effective_end" "date",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rates_check" CHECK ((("effective_end" IS NULL) OR ("effective_end" >= "effective_start")))
);


ALTER TABLE "public"."rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "worker_id" "uuid",
    "source_name" "text" NOT NULL,
    "work_date" "date" NOT NULL,
    "tracked_seconds" integer DEFAULT 0 NOT NULL,
    "project" "text",
    "activity_pct" numeric(5,2),
    "approval" "public"."approval_status" DEFAULT 'pending'::"public"."approval_status" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "pay_period_id" "uuid",
    "import_batch_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pto_seconds" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."time_entries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_payouts_by_period" WITH ("security_invoker"='true') AS
 SELECT "p"."company_id",
    "c"."name" AS "company_name",
    "pp"."period_start",
    "pp"."period_end",
    "count"(*) AS "contractor_count",
    "sum"("p"."net_php") AS "total_net_php",
    "sum"("p"."payout_amount") AS "total_payout",
    "p"."payout_currency"
   FROM (("public"."payments" "p"
     JOIN "public"."pay_periods" "pp" ON (("pp"."id" = "p"."pay_period_id")))
     JOIN "public"."companies" "c" ON (("c"."id" = "p"."company_id")))
  GROUP BY "p"."company_id", "c"."name", "pp"."period_start", "pp"."period_end", "p"."payout_currency";


ALTER VIEW "public"."v_payouts_by_period" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."worker_companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "company_id" "uuid" NOT NULL,
    "role" "text",
    "contract" "public"."contract_type" DEFAULT 'FT'::"public"."contract_type" NOT NULL,
    "hubstaff_name" "text",
    "status" "public"."worker_status" DEFAULT 'active'::"public"."worker_status" NOT NULL,
    "started_on" "date",
    "ended_on" "date",
    "hubstaff_user_id" bigint,
    "bill_rate_usd" numeric(12,2),
    "weekly_hours" numeric
);


ALTER TABLE "public"."worker_companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."worker_tools" (
    "worker_id" "uuid" NOT NULL,
    "requested" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "enc" "text",
    "provisioned_at" timestamp with time zone,
    "popup_pending" boolean DEFAULT false NOT NULL,
    "acked_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."worker_tools" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "match_key" "text" GENERATED ALWAYS AS ((("lower"(TRIM(BOTH FROM "first_name")) || ' '::"text") || "lower"(TRIM(BOTH FROM "last_name")))) STORED,
    "status" "public"."worker_status" DEFAULT 'active'::"public"."worker_status" NOT NULL,
    "email" "text",
    "mobile" "text",
    "ph_address" "text",
    "date_of_birth" "date",
    "hire_date" "date",
    "payout_method" "public"."payout_method",
    "payout_account" "jsonb",
    "gcash" "text",
    "paymaya" "text",
    "paypal" "text",
    "health_allowance_eligible" boolean DEFAULT true NOT NULL,
    "thirteenth_month_eligible" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "wise_recipients" "jsonb" DEFAULT '[]'::"jsonb",
    "wise_recipient_id" bigint,
    "middle_name" "text",
    "wise_recipient_uuid" "text",
    "photo_url" "text",
    "wise_tag" "text",
    "emergency_name" "text",
    "emergency_relationship" "text",
    "emergency_mobile" "text",
    "permanent_address" "text",
    "address_landmark" "text",
    "postal_code" "text",
    "marital_status" "text",
    "education_level" "text",
    "course" "text",
    "year_graduated" "text",
    "school" "text",
    "profile_extras" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "work_email" "text",
    "work_number" "text",
    "work_extension" "text",
    "shift_start" time without time zone,
    "shift_end" time without time zone,
    "created_by" "uuid" DEFAULT "auth"."uid"()
);


ALTER TABLE "public"."workers" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_companies"
    ADD CONSTRAINT "admin_companies_pkey" PRIMARY KEY ("admin_email", "company_id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."agreement_templates"
    ADD CONSTRAINT "agreement_templates_pkey" PRIMARY KEY ("kind");



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("provider");



ALTER TABLE ONLY "public"."app_secrets"
    ADD CONSTRAINT "app_secrets_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contractor_logins"
    ADD CONSTRAINT "contractor_logins_auth_user_id_key" UNIQUE ("auth_user_id");



ALTER TABLE ONLY "public"."contractor_logins"
    ADD CONSTRAINT "contractor_logins_pkey" PRIMARY KEY ("worker_id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hubstaff_projects"
    ADD CONSTRAINT "hubstaff_projects_pkey" PRIMARY KEY ("hubstaff_project_id");



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mood_checkins"
    ADD CONSTRAINT "mood_checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_agreements"
    ADD CONSTRAINT "onboarding_agreements_pkey" PRIMARY KEY ("worker_id", "agreement_kind");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("worker_id");



ALTER TABLE ONLY "public"."onboarding_reminders"
    ADD CONSTRAINT "onboarding_reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_signatures"
    ADD CONSTRAINT "onboarding_signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_signatures"
    ADD CONSTRAINT "onboarding_signatures_worker_id_agreement_kind_doc_version_key" UNIQUE ("worker_id", "agreement_kind", "doc_version");



ALTER TABLE ONLY "public"."pay_periods"
    ADD CONSTRAINT "pay_periods_company_id_period_start_period_end_key" UNIQUE ("company_id", "period_start", "period_end");



ALTER TABLE ONLY "public"."pay_periods"
    ADD CONSTRAINT "pay_periods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pay_period_id_worker_id_key" UNIQUE ("pay_period_id", "worker_id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_admins"
    ADD CONSTRAINT "pending_admins_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."portal_notifications"
    ADD CONSTRAINT "portal_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_settings"
    ADD CONSTRAINT "portal_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rates"
    ADD CONSTRAINT "rates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_company_id_source_name_work_date_key" UNIQUE ("company_id", "source_name", "work_date");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_companies"
    ADD CONSTRAINT "worker_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_companies"
    ADD CONSTRAINT "worker_companies_worker_id_company_id_key" UNIQUE ("worker_id", "company_id");



ALTER TABLE ONLY "public"."worker_tools"
    ADD CONSTRAINT "worker_tools_pkey" PRIMARY KEY ("worker_id");



ALTER TABLE ONLY "public"."workers"
    ADD CONSTRAINT "workers_pkey" PRIMARY KEY ("id");



CREATE INDEX "admin_companies_email_idx" ON "public"."admin_companies" USING "btree" ("lower"("admin_email"));



CREATE INDEX "audit_log_company_idx" ON "public"."audit_log" USING "btree" ("company_id", "created_at");



CREATE INDEX "documents_expires_on_idx" ON "public"."documents" USING "btree" ("expires_on");



CREATE INDEX "documents_review_status_idx" ON "public"."documents" USING "btree" ("review_status");



CREATE INDEX "documents_worker_id_idx" ON "public"."documents" USING "btree" ("worker_id");



CREATE INDEX "hubstaff_projects_company_id_idx" ON "public"."hubstaff_projects" USING "btree" ("company_id");



CREATE INDEX "invoice_lines_invoice_idx" ON "public"."invoice_lines" USING "btree" ("invoice_id");



CREATE INDEX "invoices_company_period_idx" ON "public"."invoices" USING "btree" ("company_id", "period_start", "period_end");



CREATE UNIQUE INDEX "invoices_one_live_per_period" ON "public"."invoices" USING "btree" ("company_id", "period_start", "period_end") WHERE ("status" <> 'void'::"text");



CREATE INDEX "onboarding_reminders_worker_idx" ON "public"."onboarding_reminders" USING "btree" ("worker_id");



CREATE INDEX "onboarding_signatures_worker_idx" ON "public"."onboarding_signatures" USING "btree" ("worker_id");



CREATE INDEX "payments_company_id_idx" ON "public"."payments" USING "btree" ("company_id");



CREATE INDEX "payments_pay_period_id_idx" ON "public"."payments" USING "btree" ("pay_period_id");



CREATE INDEX "portal_notifications_open_idx" ON "public"."portal_notifications" USING "btree" ("worker_id", "created_at" DESC) WHERE ("dismissed_at" IS NULL);



CREATE INDEX "rates_worker_id_company_id_effective_start_idx" ON "public"."rates" USING "btree" ("worker_id", "company_id", "effective_start");



CREATE INDEX "time_entries_company_id_work_date_idx" ON "public"."time_entries" USING "btree" ("company_id", "work_date");



CREATE INDEX "time_entries_pay_period_id_idx" ON "public"."time_entries" USING "btree" ("pay_period_id");



CREATE INDEX "time_entries_worker_id_idx" ON "public"."time_entries" USING "btree" ("worker_id");



CREATE UNIQUE INDEX "worker_companies_company_hubstaff_user" ON "public"."worker_companies" USING "btree" ("company_id", "hubstaff_user_id") WHERE ("hubstaff_user_id" IS NOT NULL);



CREATE INDEX "worker_companies_company_id_idx" ON "public"."worker_companies" USING "btree" ("company_id");



CREATE INDEX "workers_match_key_idx" ON "public"."workers" USING "btree" ("match_key");



CREATE OR REPLACE TRIGGER "admin_users_no_truncate_trg" BEFORE TRUNCATE ON "public"."admin_users" FOR EACH STATEMENT EXECUTE FUNCTION "public"."admin_users_no_truncate"();



CREATE OR REPLACE TRIGGER "admin_users_owner_check_trg" AFTER DELETE OR UPDATE ON "public"."admin_users" FOR EACH ROW EXECUTE FUNCTION "public"."admin_users_owner_check"();



CREATE OR REPLACE TRIGGER "trg_payments_lock_enforce" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."payments_lock_enforce"();



ALTER TABLE ONLY "public"."admin_companies"
    ADD CONSTRAINT "admin_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contractor_logins"
    ADD CONSTRAINT "contractor_logins_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contractor_logins"
    ADD CONSTRAINT "contractor_logins_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hubstaff_projects"
    ADD CONSTRAINT "hubstaff_projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_lines"
    ADD CONSTRAINT "invoice_lines_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mood_checkins"
    ADD CONSTRAINT "mood_checkins_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_agreements"
    ADD CONSTRAINT "onboarding_agreements_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_reminders"
    ADD CONSTRAINT "onboarding_reminders_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_signatures"
    ADD CONSTRAINT "onboarding_signatures_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pay_periods"
    ADD CONSTRAINT "pay_periods_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pay_period_id_fkey" FOREIGN KEY ("pay_period_id") REFERENCES "public"."pay_periods"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pending_admins"
    ADD CONSTRAINT "pending_admins_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."portal_notifications"
    ADD CONSTRAINT "portal_notifications_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rates"
    ADD CONSTRAINT "rates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rates"
    ADD CONSTRAINT "rates_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pay_period_id_fkey" FOREIGN KEY ("pay_period_id") REFERENCES "public"."pay_periods"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_companies"
    ADD CONSTRAINT "worker_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_companies"
    ADD CONSTRAINT "worker_companies_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_tools"
    ADD CONSTRAINT "worker_tools_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE CASCADE;



ALTER TABLE "public"."admin_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_companies_owner_all" ON "public"."admin_companies" TO "authenticated" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "admin_companies_read_self" ON "public"."admin_companies" FOR SELECT TO "authenticated" USING (("lower"("admin_email") = ( SELECT "lower"("admin_users"."email") AS "lower"
   FROM "public"."admin_users"
  WHERE ("admin_users"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_users_read" ON "public"."admin_users" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."agreement_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agreement_templates_admin_all" ON "public"."agreement_templates" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "agreement_templates_read" ON "public"."agreement_templates" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "announcements_admin_write" ON "public"."announcements" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "announcements_read" ON "public"."announcements" FOR SELECT TO "authenticated" USING (("active" OR "public"."is_admin"()));



ALTER TABLE "public"."api_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_admin_all" ON "public"."audit_log" TO "authenticated" USING ("public"."is_company_admin"("company_id")) WITH CHECK ("public"."is_company_admin"("company_id"));



ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "companies_admin_all" ON "public"."companies" TO "authenticated" USING ("public"."is_company_admin"("id")) WITH CHECK ("public"."is_company_admin"("id"));



ALTER TABLE "public"."contractor_logins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contractor_logins_self" ON "public"."contractor_logins" FOR SELECT TO "authenticated" USING ((("auth_user_id" = "auth"."uid"()) OR "public"."admin_can_see_worker"("worker_id")));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_admin_all" ON "public"."documents" TO "authenticated" USING (("public"."admin_can_see_worker"("worker_id") OR "public"."is_company_admin"("company_id"))) WITH CHECK (("public"."admin_can_see_worker"("worker_id") OR "public"."is_company_admin"("company_id")));



CREATE POLICY "documents_contractor_insert" ON "public"."documents" FOR INSERT TO "authenticated" WITH CHECK ((("worker_id" = "public"."my_worker_id"()) AND ("kind" <> 'other'::"public"."document_kind") AND ("review_status" = 'pending'::"public"."review_status") AND ("reviewed_by" IS NULL) AND ("reviewed_at" IS NULL)));



CREATE POLICY "documents_contractor_read" ON "public"."documents" FOR SELECT TO "authenticated" USING ((("worker_id" = "public"."my_worker_id"()) AND ("kind" <> 'other'::"public"."document_kind")));



ALTER TABLE "public"."hubstaff_projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hubstaff_projects_admin_all" ON "public"."hubstaff_projects" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))));



ALTER TABLE "public"."invoice_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_lines_admin_all" ON "public"."invoice_lines" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_lines"."invoice_id") AND (( SELECT "public"."is_owner"() AS "is_owner") OR ("i"."company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))))))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR (EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_lines"."invoice_id") AND (( SELECT "public"."is_owner"() AS "is_owner") OR ("i"."company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))))))));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_admin_all" ON "public"."invoices" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))));



ALTER TABLE "public"."mood_checkins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mood_self_insert" ON "public"."mood_checkins" FOR INSERT TO "authenticated" WITH CHECK (("worker_id" = "public"."my_worker_id"()));



CREATE POLICY "mood_self_read" ON "public"."mood_checkins" FOR SELECT TO "authenticated" USING ((("worker_id" = "public"."my_worker_id"()) OR "public"."admin_can_see_worker"("worker_id")));



ALTER TABLE "public"."onboarding_agreements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_agreements_admin_all" ON "public"."onboarding_agreements" TO "authenticated" USING ("public"."admin_can_see_worker"("worker_id")) WITH CHECK ("public"."admin_can_see_worker"("worker_id"));



CREATE POLICY "onboarding_agreements_read_own" ON "public"."onboarding_agreements" FOR SELECT TO "authenticated" USING (("worker_id" = "public"."my_worker_id"()));



ALTER TABLE "public"."onboarding_progress" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_progress_admin_write" ON "public"."onboarding_progress" TO "authenticated" USING ("public"."admin_can_see_worker"("worker_id")) WITH CHECK ("public"."admin_can_see_worker"("worker_id"));



CREATE POLICY "onboarding_progress_read" ON "public"."onboarding_progress" FOR SELECT TO "authenticated" USING ((("worker_id" = "public"."my_worker_id"()) OR "public"."admin_can_see_worker"("worker_id")));



ALTER TABLE "public"."onboarding_reminders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."onboarding_signatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_signatures_read" ON "public"."onboarding_signatures" FOR SELECT TO "authenticated" USING ((("worker_id" = "public"."my_worker_id"()) OR "public"."admin_can_see_worker"("worker_id")));



ALTER TABLE "public"."pay_periods" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pay_periods_admin_all" ON "public"."pay_periods" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))));



CREATE POLICY "pay_periods_contractor_read" ON "public"."pay_periods" FOR SELECT TO "authenticated" USING (((( SELECT "public"."my_worker_id"() AS "my_worker_id") IS NOT NULL) AND ( SELECT "public"."is_onboarded"() AS "is_onboarded")));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_admin_all" ON "public"."payments" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))));



CREATE POLICY "payments_contractor_read" ON "public"."payments" FOR SELECT TO "authenticated" USING ((("worker_id" = ( SELECT "public"."my_worker_id"() AS "my_worker_id")) AND ( SELECT "public"."is_onboarded"() AS "is_onboarded")));



ALTER TABLE "public"."pending_admins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pending_admins_read" ON "public"."pending_admins" FOR SELECT USING ("public"."is_owner"());



ALTER TABLE "public"."portal_notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_notifications_dismiss" ON "public"."portal_notifications" FOR UPDATE TO "authenticated" USING (("worker_id" = "public"."my_worker_id"())) WITH CHECK (("worker_id" = "public"."my_worker_id"()));



CREATE POLICY "portal_notifications_read" ON "public"."portal_notifications" FOR SELECT TO "authenticated" USING ((("worker_id" = "public"."my_worker_id"()) OR "public"."admin_can_see_worker"("worker_id")));



ALTER TABLE "public"."portal_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_settings_admin_write" ON "public"."portal_settings" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "portal_settings_read" ON "public"."portal_settings" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."rates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rates_admin_all" ON "public"."rates" TO "authenticated" USING ("public"."is_company_admin"("company_id")) WITH CHECK ("public"."is_company_admin"("company_id"));



ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "time_entries_admin_all" ON "public"."time_entries" TO "authenticated" USING ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest")))) WITH CHECK ((( SELECT "public"."is_owner"() AS "is_owner") OR ("company_id" IN ( SELECT "unnest"("public"."my_admin_company_ids"()) AS "unnest"))));



CREATE POLICY "time_entries_contractor_read" ON "public"."time_entries" FOR SELECT TO "authenticated" USING ((("worker_id" = ( SELECT "public"."my_worker_id"() AS "my_worker_id")) AND ( SELECT "public"."is_onboarded"() AS "is_onboarded")));



ALTER TABLE "public"."worker_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "worker_companies_admin_all" ON "public"."worker_companies" TO "authenticated" USING ("public"."is_company_admin"("company_id")) WITH CHECK ("public"."is_company_admin"("company_id"));



ALTER TABLE "public"."worker_tools" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workers_admin_delete" ON "public"."workers" FOR DELETE TO "authenticated" USING ("public"."admin_can_see_worker"("id"));



CREATE POLICY "workers_admin_insert" ON "public"."workers" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());



CREATE POLICY "workers_admin_select" ON "public"."workers" FOR SELECT TO "authenticated" USING (("public"."admin_can_see_worker"("id") OR ("created_by" = "auth"."uid"())));



CREATE POLICY "workers_admin_update" ON "public"."workers" FOR UPDATE TO "authenticated" USING (("public"."admin_can_see_worker"("id") OR ("created_by" = "auth"."uid"()))) WITH CHECK (("public"."admin_can_see_worker"("id") OR ("created_by" = "auth"."uid"())));



CREATE POLICY "workers_contractor_read" ON "public"."workers" FOR SELECT TO "authenticated" USING (("id" = "public"."my_worker_id"()));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";














































































































































































GRANT ALL ON FUNCTION "public"."ack_my_tools"() TO "anon";
GRANT ALL ON FUNCTION "public"."ack_my_tools"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ack_my_tools"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_can_see_worker"("wid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_can_see_worker"("wid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_can_see_worker"("wid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_lookup_auth_user"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_lookup_auth_user"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_users_no_truncate"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_users_no_truncate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_users_no_truncate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_users_owner_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_users_owner_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_users_owner_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."allocate_invoice_no"("p_year" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_invoice_no"("p_year" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_invoice_no"("p_year" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."bind_pending_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."bind_pending_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bind_pending_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."decrypt_worker_tools"("p_worker_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decrypt_worker_tools"("p_worker_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_tools"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_tools"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_tools"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tools_status"("p_worker_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tools_status"("p_worker_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tools_status"("p_worker_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_company_admin"("cid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_company_admin"("cid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_company_admin"("cid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_onboarded"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_onboarded"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_onboarded"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."my_admin_company_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_admin_company_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_admin_company_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."my_worker_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_worker_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_worker_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."payments_lock_enforce"() TO "anon";
GRANT ALL ON FUNCTION "public"."payments_lock_enforce"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."payments_lock_enforce"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_time_entry_activity"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_time_entry_activity"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_tools_requested"("p_worker_id" "uuid", "p_requested" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_tools_requested"("p_worker_id" "uuid", "p_requested" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_tools_requested"("p_worker_id" "uuid", "p_requested" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_worker_tools"("p_worker_id" "uuid", "p_creds" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_worker_tools"("p_worker_id" "uuid", "p_creds" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_worker_tools"("p_worker_id" "uuid", "p_creds" "jsonb") TO "service_role";
























GRANT ALL ON TABLE "public"."admin_companies" TO "anon";
GRANT ALL ON TABLE "public"."admin_companies" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_companies" TO "service_role";



GRANT SELECT,TRIGGER,MAINTAIN ON TABLE "public"."admin_users" TO "anon";
GRANT SELECT,TRIGGER,MAINTAIN ON TABLE "public"."admin_users" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_users" TO "service_role";



GRANT ALL ON TABLE "public"."agreement_templates" TO "anon";
GRANT ALL ON TABLE "public"."agreement_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."agreement_templates" TO "service_role";



GRANT ALL ON TABLE "public"."announcements" TO "anon";
GRANT ALL ON TABLE "public"."announcements" TO "authenticated";
GRANT ALL ON TABLE "public"."announcements" TO "service_role";



GRANT ALL ON TABLE "public"."api_tokens" TO "anon";
GRANT ALL ON TABLE "public"."api_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."api_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."app_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."companies" TO "anon";
GRANT ALL ON TABLE "public"."companies" TO "authenticated";
GRANT ALL ON TABLE "public"."companies" TO "service_role";



GRANT ALL ON TABLE "public"."contractor_logins" TO "anon";
GRANT ALL ON TABLE "public"."contractor_logins" TO "authenticated";
GRANT ALL ON TABLE "public"."contractor_logins" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."hubstaff_projects" TO "anon";
GRANT ALL ON TABLE "public"."hubstaff_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."hubstaff_projects" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_lines" TO "anon";
GRANT ALL ON TABLE "public"."invoice_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_lines" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."mood_checkins" TO "anon";
GRANT ALL ON TABLE "public"."mood_checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."mood_checkins" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_agreements" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_agreements" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_agreements" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_progress" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_reminders" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_reminders" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_signatures" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_signatures" TO "service_role";



GRANT ALL ON TABLE "public"."pay_periods" TO "anon";
GRANT ALL ON TABLE "public"."pay_periods" TO "authenticated";
GRANT ALL ON TABLE "public"."pay_periods" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pending_admins" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pending_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_admins" TO "service_role";



GRANT ALL ON TABLE "public"."portal_notifications" TO "anon";
GRANT ALL ON TABLE "public"."portal_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."portal_settings" TO "anon";
GRANT ALL ON TABLE "public"."portal_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_settings" TO "service_role";



GRANT ALL ON TABLE "public"."rates" TO "anon";
GRANT ALL ON TABLE "public"."rates" TO "authenticated";
GRANT ALL ON TABLE "public"."rates" TO "service_role";



GRANT ALL ON TABLE "public"."time_entries" TO "anon";
GRANT ALL ON TABLE "public"."time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_entries" TO "service_role";



GRANT ALL ON TABLE "public"."v_payouts_by_period" TO "anon";
GRANT ALL ON TABLE "public"."v_payouts_by_period" TO "authenticated";
GRANT ALL ON TABLE "public"."v_payouts_by_period" TO "service_role";



GRANT ALL ON TABLE "public"."worker_companies" TO "anon";
GRANT ALL ON TABLE "public"."worker_companies" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_companies" TO "service_role";



GRANT ALL ON TABLE "public"."worker_tools" TO "anon";
GRANT ALL ON TABLE "public"."worker_tools" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_tools" TO "service_role";



GRANT ALL ON TABLE "public"."workers" TO "anon";
GRANT ALL ON TABLE "public"."workers" TO "authenticated";
GRANT ALL ON TABLE "public"."workers" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































