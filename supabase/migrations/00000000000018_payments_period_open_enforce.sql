-- ---------------------------------------------------------------------------
-- New-1: make pay-period locking authoritative at the DB layer.
--
-- Period locking was purely application-level: calculateDraft() checks
-- pay_periods.state = 'open', then later upserts payment rows in a separate
-- statement with no transaction. A lock landing in that window (TOCTOU race)
-- would let recalc overwrite gross/net/HA/13th on a row of a now-locked period,
-- silently re-deriving a "locked" snapshot from current time/rates.
--
-- The only existing payments trigger (payments_lock_enforce) keys off
-- wise_locked_at, not pay_periods.state, so it does not guard this.
--
-- This trigger enforces the invariant directly:
--   * INSERT  — a payment may only be created while its period is 'open'.
--   * UPDATE  — the monetary / computed columns are frozen once the period
--               leaves 'open'. Operational columns (status, paid_at, wise_*,
--               note, payout_method/amount/currency, fx_rate, original_net_php)
--               stay editable so mark-paid / mark-unpaid / reconcile / wise
--               row-lock flows keep working on locked & paid periods.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."payments_period_open_enforce"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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

CREATE OR REPLACE TRIGGER "trg_payments_period_open_enforce_ins"
  BEFORE INSERT ON "public"."payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."payments_period_open_enforce"();

CREATE OR REPLACE TRIGGER "trg_payments_period_open_enforce_upd"
  BEFORE UPDATE ON "public"."payments"
  FOR EACH ROW EXECUTE FUNCTION "public"."payments_period_open_enforce"();

GRANT ALL ON FUNCTION "public"."payments_period_open_enforce"() TO "anon";
GRANT ALL ON FUNCTION "public"."payments_period_open_enforce"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."payments_period_open_enforce"() TO "service_role";
