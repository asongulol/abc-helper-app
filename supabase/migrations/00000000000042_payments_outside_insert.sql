-- ---------------------------------------------------------------------------
-- Outside payments: allow inserting a RECORD of money that already moved.
--
-- The period-open trigger (migration 18) exists so a recalc can never write a
-- computed draft into a locked/paid snapshot. An OUTSIDE payment — a remittance
-- made without the app (BPI/GCash by hand, a Wise transfer sent from the Wise
-- site) — is the opposite case: the period is usually already locked/paid, and
-- the missing row is exactly what is being repaired. Such a record arrives
-- already 'sent' with its paid_at and no Wise link (matching links it later).
--
-- Only the INSERT branch changes; draft/queued inserts stay open-only and the
-- UPDATE freeze on monetary columns is untouched (so the record itself is
-- frozen the moment it lands on a closed period).
--
-- LOCAL LINEAGE ONLY — do NOT apply to shared prod. Like migration 18 it
-- amends, the period-open trigger is deliberately ABSENT from prod
-- (cgsidolrauzsowqlllsz): the legacy apps still write payments there, and the
-- 2026-06-22 attempt to add it broke them (see audit/CUTOVER-PLAN-2026-06-24.md
-- §2.2). Verified 2026-08-28 via MCP: prod has only trg_payments_lock_enforce
-- (BEFORE UPDATE), so outside-payment INSERTs need no prod-side change at all.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."payments_period_open_enforce"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_state public.pay_period_state;
  changed_cols text[] := '{}';
begin
  -- INSERT: payments may only be created for an open period — except an
  -- outside-payment record ('sent' + paid_at, unlinked), which may be appended
  -- to a closed period.
  if (tg_op = 'INSERT') then
    if new.status = 'sent' and new.paid_at is not null and new.wise_transfer_id is null then
      return new;
    end if;
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
