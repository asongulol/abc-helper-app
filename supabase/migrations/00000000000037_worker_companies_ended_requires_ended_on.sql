-- ============================================================================
-- 37: an 'ended' company link must carry the day it ended on
-- ----------------------------------------------------------------------------
-- `ended_on` is what every last-day rule in this app measures against — the
-- time-import guard (src/db/queries/time.ts), the payroll allowance gate, the
-- portal's final-pay gate. A link marked 'ended' with a NULL `ended_on` is a
-- departure with no last day: nothing can be bounded by it, so the guards
-- deliberately leave it alone and the contractor keeps importing and paying.
--
-- `endEngagement` stamps it. Three other writers did not:
--   * `saveWorkerCompanyLink` (fixed in this stack — 'ended' is no longer a
--     status a profile form can write)
--   * `withdrawOffer` (src/server/actions/portal-admin.ts — fixed alongside
--     this migration; now routes through `endEngagement`)
--   * the DEPLOYED legacy edge function `portal-admin`'s withdraw_offer
--     (abc-work-app-payroll-wis-hubstaff-app/supabase/functions/portal-admin/
--     index.ts:467) — PATCHes bare {status:"ended"} across every link, and we
--     cannot fix it from this repo. This constraint is the only thing that
--     stops it. The legacy call is wrapped in `.catch(() => {})`, so after this
--     applies the PATCH 400s silently and the link stays 'active' — visibly
--     wrong on the roster, which beats invisibly unbounded.
--
-- The legacy admin apps' own "set inactive" flow (setActive, all three apps)
-- already writes {status:"ended", ended_on:<today>}, so this constraint does
-- NOT break it. Verified by grep across all three sibling repos: the legacy
-- portal-admin edge function is the ONLY bare-'ended' writer left.
--
-- ADDITIVE per docs/shared-prod-conformance.md: a new CHECK constraint. It
-- renames nothing, drops nothing, retypes nothing. It does newly REJECT one
-- legacy write shape (above), which is the point of the ticket.
--
-- ⚠️ Local/CI only — the prod copy is hand-applied via the Dashboard/MCP
-- (disjoint history), then recorded in supabase/prod-applied.json. IDEMPOTENT
-- and re-runnable: if a concurrent bare-'ended' write from a legacy app lands
-- between the backfill and the ADD CONSTRAINT, the ADD fails and you simply
-- run the file again.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Backfill. The constraint cannot be added while a violating row exists, and
-- prod plausibly has some (both withdraw-offer paths above have been live).
--
-- Choosing a value is the whole difficulty: guessing a last day RETROACTIVELY
-- INVALIDATES real hours, which is why the app-side guards refuse to guess.
-- So the backfill does not guess either — it uses the latest date the link
-- itself can evidence:
--
--   1. the last day they actually logged time at this company  (a fact)
--   2. else the day the engagement started                     (a fact)
--   3. else today                                              (no evidence;
--      blocks nothing that already exists, only future dates)
--
-- greatest() ignores NULLs in Postgres, so (1) and (2) fold without a CASE.
-- Every value chosen is >= every time entry that already exists for the pair,
-- so no already-imported day is retroactively invalidated by this backfill and
-- migration 38's trigger cannot reject an existing row.
--
-- Concurrency: the WHERE touches only rows that ALREADY violate the invariant
-- (`status='ended' and ended_on is null`) — a state no correct writer creates —
-- so it takes row locks on nothing another app is meaningfully editing.
-- ---------------------------------------------------------------------------
update public.worker_companies wc
set ended_on = coalesce(
      greatest(
        (select max(t.work_date)
           from public.time_entries t
          where t.company_id = wc.company_id
            and t.worker_id = wc.worker_id),
        wc.started_on
      ),
      current_date
    )
where wc.status = 'ended'
  and wc.ended_on is null;

-- ---------------------------------------------------------------------------
-- The invariant. Only constrains the 'ended' direction: an active or inactive
-- link may still carry an `ended_on` (a closed link brought back by
-- `reactivateWorkerLink` clears it, but nothing depends on that ordering).
-- ---------------------------------------------------------------------------
alter table public.worker_companies
  drop constraint if exists worker_companies_ended_requires_ended_on;

alter table public.worker_companies
  add constraint worker_companies_ended_requires_ended_on
  check (status <> 'ended' or ended_on is not null);

comment on constraint worker_companies_ended_requires_ended_on on public.worker_companies is
  'An ended engagement must record its last day: ended_on is what the time-import, payroll and portal last-day rules measure against, and NULL means unbounded. Use endEngagement() rather than writing status directly.';

-- ROLLBACK:
--   alter table public.worker_companies
--     drop constraint if exists worker_companies_ended_requires_ended_on;
--   (the backfilled ended_on values are left in place — they are the best
--   available evidence of each last day, and dropping them restores the bug.)
