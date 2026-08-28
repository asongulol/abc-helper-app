'use server';

/**
 * Payroll server actions — WIRED (the Phase-2 pattern-setters).
 * Flow per action: verify admin (re-verification at point of use, ADR-0004) →
 * Zod-validate input → query module / service → audit log. No inline SQL,
 * no money math here — that lives in src/lib (pure) and src/db/queries.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import type {
  OffCycleItemRow,
  PeriodSummaryRow,
  ProcessPayment,
  SavedPayment,
} from '@/db/queries/payroll';
import {
  applyGrossOverride,
  clearSessionsPaid,
  deleteAllStatements as dbDeleteAllStatements,
  deleteStatement as dbDeleteStatement,
  deleteOffCycleItemsForStatements,
  fetchOffCycleItemsForWorkerPeriod,
  fetchPeriodById,
  fetchPeriodIdsForPayments,
  fetchPeriodState,
  fetchPeriodStatesByWindow,
  fetchPeriodStatesForPayments,
  fetchPeriodSummaries,
  fetchPreviousRegularPeriodId,
  fetchPriorPayments,
  fetchProcessPayments,
  fetchRoster,
  fetchSavedPayments,
  findOrCreateOffCycleBatch,
  findPeriod,
  hasInAppRecalc,
  markPaymentsPaid,
  markPaymentsUnpaid,
  officeToday,
  requireOpenPeriod,
  restorePaymentRows,
  setWiseRowLock,
  stepPeriodToLocked,
  syncPeriodPaidState,
  unpayablePeriodReason,
  updatePaymentRow,
} from '@/db/queries/payroll';
import type { RateHistoryRow } from '@/db/queries/rates';
import { executeRateUpsert, fetchRateHistory } from '@/db/queries/rates';
import {
  fetchRecentSessionsForWorkers,
  fetchUnpaidApprovedSessions,
  type RecentSessionRow,
  type UnpaidSessionRow,
} from '@/db/queries/sessions';
import { unapproveWindow } from '@/db/queries/time';
import { periodFor } from '@/lib/dates/periods';
import { humanizeError } from '@/lib/errors';
import { centavos } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { composeNet, miscTotal } from '@/lib/pay/calc';
import { payModelFor } from '@/lib/pay/expected-hours';
import { isCarriedOverClone } from '@/lib/payroll/carried-over';
import { centavosToPhp, phpToCentavos } from '@/lib/payroll/mappers';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  addOffCycleEntry,
  addSalariedCatchUpEntry,
  paySessionsIntoOffCycleBatch,
  paySessionsIntoOpenDraft,
  paySessionsIntoPeriod,
  removeOffCycleEntry,
} from '@/server/off-cycle';
import {
  type CalculateDraftResult,
  type CatchUpCandidate,
  calculateDraft,
  lockRun,
  reconcileApprovedTime,
  salariedCatchUpCandidates,
  unlockRun,
} from '@/server/payroll';
import {
  AddOffCyclePaySchema,
  AddSalariedCatchUpSchema,
  CalculateDraftSchema,
  DeleteAllStatementsSchema,
  DeleteStatementSchema,
  LockPeriodSchema,
  MarkAllUnpaidSchema,
  MarkPaidSchema,
  RateSaveSchema,
  RemoveOffCyclePaySchema,
  RestoreSnapshotSchema,
  ToggleWiseRowLockSchema,
  UnlockPeriodSchema,
  UpdatePaymentRowSchema,
} from '@/types/schemas/payroll';

/**
 * A period changed state (open → locked → paid). Every admin page that lists
 * batches reads that state server-side — Process & Pay, Calculate, Overview,
 * Batches — so drop the client Router Cache, which otherwise keeps replaying
 * the pre-lock render: a batch locked in Calculate stayed invisible in Process
 * & Pay (and its "waiting upstream: not yet locked" banner stayed up) until a
 * hard reload. Called from a Server Action, this clears the whole client cache,
 * which is the point — the stale entry is on the page we're NOT on.
 */
const revalidatePeriodViews = () => revalidatePath('/', 'layout');

/**
 * Effective-dated rate save (legacy `saveRate`). Same-day saves replace;
 * earlier open rates are closed; the change is audit-logged from→to.
 */
export async function saveRate(args: unknown): Promise<ActionResult<{ kind: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RateSaveSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const result = await executeRateUpsert(db, {
      workerId: input.workerId,
      companyId: input.companyId,
      amountPhp: input.amountPhp,
      effectiveStart: input.effectiveStart,
    });
    await logEvent({
      companyId: input.companyId,
      action: 'set_rate',
      entity: input.workerId,
      detail: {
        amount_php: { from: result.priorAmountPhp, to: input.amountPhp },
        effective_start: input.effectiveStart,
        kind: result.kind,
      },
    });
    return { ok: true, data: { kind: result.kind } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Rate save failed.'),
    };
  }
}

/** Rate history for a worker in a company (newest first). */
export async function getRateHistory(args: {
  workerId: string;
  companyId: string;
}): Promise<ActionResult<{ history: RateHistoryRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const db = await createServerSupabase();
    const history = await fetchRateHistory(db, args.workerId, args.companyId);
    return { ok: true, data: { history } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/**
 * Recalculate a period from tracked hours and save as DRAFT (legacy
 * `calculate`). The UI owns the destructive-recalc warning + undo snapshot;
 * the service refuses locked/paid periods.
 */
export async function calculatePeriodDraft(
  args: unknown,
): Promise<ActionResult<CalculateDraftResult>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = CalculateDraftSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const result = await calculateDraft(input);
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Calculate failed.'),
    };
  }
}

/**
 * F6: undo the most recent recalc. Only valid while the period is still OPEN.
 *
 * RP-23: the rows come from the snapshot calculateDraft parked on the period,
 * NOT from the caller. `RestoreSnapshotSchema.snapshot` was
 * `z.array(z.record(z.string(), z.unknown()))` and only company_id/pay_period_id
 * were forced, so every money column plus `status` and `paid_at` inserted
 * exactly as posted — bypassing the server-side net recomposition and the
 * positive-gross rule. The client's copy is now ignored (kept on the schema
 * because the payroll shell still posts it, same as CalculateDraftSchema.payDate).
 */
export async function restorePaymentsSnapshot(
  args: unknown,
): Promise<ActionResult<{ restored: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RestoreSnapshotSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    await requireOpenPeriod(
      db,
      { periodId: input.periodId, companyId: input.companyId },
      'cannot undo recalculation',
    );

    const snapshot = await fetchPriorPayments(db, input.periodId);
    if (snapshot.length === 0)
      return { ok: false, error: 'No saved pre-recalculation snapshot for this period to undo.' };

    const restored = await restorePaymentRows(db, input.companyId, input.periodId, snapshot);
    await logEvent({
      companyId: input.companyId,
      action: 'restore_recalc',
      entity: input.periodId,
      detail: { rows: restored },
    });
    return { ok: true, data: { restored } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Undo failed.') };
  }
}

/* ---------- Period summaries (batch list) ---------- */

export async function getPeriodSummaries(args: {
  companyId: string;
}): Promise<ActionResult<{ periods: PeriodSummaryRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const periods = await fetchPeriodSummaries(db, args.companyId);
    return { ok: true, data: { periods } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Saved payments for the editable draft table ---------- */

export async function getSavedPayments(args: {
  periodId: string;
  companyId: string;
}): Promise<ActionResult<{ payments: SavedPayment[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const payments = await fetchSavedPayments(db, args.periodId);
    return { ok: true, data: { payments } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Carried-over draft auto-recalc decision ---------- */

/**
 * Should this open regular draft be auto-recalculated on open?
 *
 * A legacy sibling app that shares this prod DB seeds a new period by cloning the
 * previous period's payment rows, so the recalculate screen shows last period's
 * amounts (misleading) until this app recomputes from the period's own hours. We
 * recompute ONCE. The trigger is gated on the durable `recalculate` audit event
 * (`hasInAppRecalc`) so it never runs a second time and can never overwrite edits
 * made after the first calculate; the carried-over check scopes it to real clones
 * and backstops a best-effort audit-write that was missed.
 */
/**
 * Pull approved time that isn't on this period's batch yet. Called when Calculate
 * opens a period, so hours approved before the approve→Calculate transfer existed
 * (or through any path that doesn't hit the approve buttons) still land. Writes
 * nothing once the batch already covers every approved worker.
 */
export async function reconcilePeriodApprovedTime(args: {
  companyId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<ActionResult<{ workers: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    return { ok: true, data: await reconcileApprovedTime(args) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not pull approved time onto Calculate.') };
  }
}

export async function shouldAutoRecalcDraft(args: {
  companyId: string;
  periodId: string;
}): Promise<ActionResult<{ auto: boolean }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const pp = await fetchPeriodById(db, args.periodId);
    if (pp?.state !== 'open' || pp.kind !== 'regular') return { ok: true, data: { auto: false } };
    // Already calculated in this app → never auto-recalc again (protects edits).
    if (await hasInAppRecalc(db, args.companyId, pp.periodStart, pp.periodEnd))
      return { ok: true, data: { auto: false } };
    const current = await fetchSavedPayments(db, args.periodId);
    if (current.length === 0) return { ok: true, data: { auto: false } };
    const prevId = await fetchPreviousRegularPeriodId(db, args.companyId, pp.periodStart);
    const previous = prevId ? await fetchSavedPayments(db, prevId) : [];
    return { ok: true, data: { auto: isCarriedOverClone(current, previous) } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Auto-recalc check failed.') };
  }
}

/* ---------- Lock period ---------- */

/**
 * Lock a pay period. Fails with the blocking reason (no-rate rows, unpaid work,
 * negative nets); when `confirmed=true` the caller has already acknowledged
 * no-method / inactive warnings. The gates live in lockRun.
 */
export async function lockPeriod(args: unknown): Promise<ActionResult<{ lockedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = LockPeriodSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const data = await lockRun(input);
    revalidatePeriodViews();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lock failed.'),
    };
  }
}

/* ---------- Unlock period ---------- */

export async function unlockPeriod(
  args: unknown,
): Promise<ActionResult<{ periodStart: string; periodEnd: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = UnlockPeriodSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    await unlockRun(input);
    revalidatePeriodViews();
    return {
      ok: true,
      data: { periodStart: input.periodStart, periodEnd: input.periodEnd },
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Unlock failed.'),
    };
  }
}

/* ---------- Update a single payment row ---------- */

/**
 * Update editable fields on an open period's payment row, recomputing net
 * server-side in centavos using the same composition as the engine.
 */
export async function updatePaymentRowAction(
  args: unknown,
): Promise<ActionResult<{ netPhp: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = UpdatePaymentRowSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

    // Fetch current row to get gross + note
    const { data: cur, error: fe } = await db
      .from('payments')
      .select(
        'gross_php, computed_gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items, off_cycle_php, net_php, note, pay_period_id',
      )
      .eq('id', input.paymentId)
      .maybeSingle();
    if (fe || !cur) return { ok: false, error: 'Payment not found.' };

    // Verify period is open (and the payment's period is this company's).
    await requireOpenPeriod(
      db,
      { periodId: cur.pay_period_id, companyId: input.companyId },
      'unlock it to edit payments',
    );

    // Determine new field values
    const grossCur = phpToCentavos(cur.gross_php) ?? centavos(0);
    // RP-07: clearing an override now RESTORES the engine's gross, so gross is
    // no longer constant across an edit — net has to follow it.
    const gross =
      'grossPhpOverride' in input
        ? applyGrossOverride(
            {
              grossPhp: centavosToPhp(grossCur),
              computedGrossPhp:
                cur.computed_gross_php == null ? null : Number(cur.computed_gross_php),
              note: cur.note ?? null,
            },
            input.grossPhpOverride == null
              ? null
              : centavosToPhp(phpToCentavos(input.grossPhpOverride) ?? grossCur),
          )
        : null;
    const grossNew = gross ? (phpToCentavos(gross.grossPhp) ?? grossCur) : grossCur;

    const haNew =
      phpToCentavos(
        'haPhp' in input && input.haPhp != null
          ? input.haPhp
          : Number(cur.health_allowance_php ?? 0),
      ) ?? centavos(0);
    const t13New =
      phpToCentavos(
        't13Php' in input ? (input.t13Php ?? 0) : Number(cur.thirteenth_month_php ?? 0),
      ) ?? centavos(0);
    const pddNew =
      phpToCentavos('pddPhp' in input ? (input.pddPhp ?? 0) : Number(cur.pdd_lunch_php ?? 0)) ??
      centavos(0);
    const bonusNew =
      phpToCentavos('bonusPhp' in input ? (input.bonusPhp ?? 0) : Number(cur.bonus_php ?? 0)) ??
      centavos(0);
    const miscItemsNew: MiscItem[] = Array.isArray(input.miscItems)
      ? (input.miscItems as MiscItem[])
      : Array.isArray(cur.misc_items)
        ? (cur.misc_items as MiscItem[])
        : [];

    // Recompute net via the engine's own composeNet — one formula everywhere.
    // off_cycle_php is durable (re-applied from the ledger on recalc) — include
    // it so editing misc never silently drops it.
    const netPhp = centavosToPhp(
      composeNet(grossNew, {
        healthAllowance: haNew,
        thirteenth: t13New,
        pddLunch: pddNew,
        bonus: bonusNew,
        misc: miscTotal(miscItemsNew),
        offCycle: phpToCentavos(Number(cur.off_cycle_php ?? 0)) ?? centavos(0),
      }),
    );

    await updatePaymentRow(db, input.paymentId, {
      ...(gross
        ? {
            grossPhp: gross.grossPhp,
            computedGrossPhp: gross.computedGrossPhp,
            note: gross.note,
          }
        : {}),
      haPhp: centavosToPhp(haNew),
      t13Php: centavosToPhp(t13New),
      pddPhp: centavosToPhp(pddNew),
      bonusPhp: centavosToPhp(bonusNew),
      miscItems: miscItemsNew,
      netPhp,
      ...('payoutMethod' in input ? { payoutMethod: input.payoutMethod ?? null } : {}),
      ...('fxRate' in input && input.fxRate != null ? { fxRate: input.fxRate } : {}),
    });

    return { ok: true, data: { netPhp } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Update failed.'),
    };
  }
}

/* ---------- Delete statement(s) ---------- */

/**
 * A deleted statement takes its off-cycle ledger rows with it and frees the
 * sessions they held paid — otherwise the sessions stay marked paid against a
 * statement that no longer exists (never re-payable), while the surviving
 * ledger rows would silently re-apply the discarded pay on the next
 * recalculate. Lives here, not in the db delete helpers, because recalc's own
 * row deletes (pruneDraftPaymentsExcept / restorePaymentRows /
 * deleteWorkerPayment) must NOT release — the ledger is designed to survive
 * recalc — and the marker clear needs the service client (sessions are
 * client-company RLS-scoped, invisible to the employer admin; ADR-0004).
 */
async function releaseSessionsForDeletedStatements(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  payPeriodId: string,
  workerId?: string,
): Promise<number> {
  const sessionIds = await deleteOffCycleItemsForStatements(db, payPeriodId, workerId);
  await clearSessionsPaid(createServiceClient(), sessionIds);
  return sessionIds.length;
}

/**
 * Removing a statement is a RETRACTION, so its hours go back to Time & Approval.
 *
 * Without this the removal doesn't stick: approved time belongs on the Calculate
 * batch, so `reconcilePeriod` rebuilds the row on the very next visit (#72) and
 * the delete looks like it did nothing. Un-approving is also what the admin
 * actually wants — the reason to pull someone off a batch is to fix their hours,
 * and hours are edited on Approval, not here.
 *
 * Only on an OPEN regular period: a locked/paid run's hours must stay approved
 * (that's the salaried catch-up card's input), and off-cycle statements are paid
 * from their own ledger, not from tracked time.
 */
async function returnTimeToApproval(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  companyId: string,
  payPeriodId: string,
  workerId?: string,
): Promise<number> {
  const period = await fetchPeriodById(db, payPeriodId);
  if (period?.state !== 'open' || period.kind === 'off_cycle') return 0;
  return unapproveWindow(db, companyId, period.periodStart, period.periodEnd, workerId);
}

export async function deleteStatement(
  args: unknown,
): Promise<ActionResult<{ deleted: number; unapproved: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteStatementSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const stmt = await dbDeleteStatement(db, input.paymentId);
    const released = stmt
      ? await releaseSessionsForDeletedStatements(db, stmt.payPeriodId, stmt.workerId)
      : 0;
    const unapproved = stmt
      ? await returnTimeToApproval(db, input.companyId, stmt.payPeriodId, stmt.workerId)
      : 0;
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: input.paymentId,
      detail: { scope: 'contractor', released_sessions: released, unapproved_entries: unapproved },
    });
    return { ok: true, data: { deleted: 1, unapproved } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}

export async function deleteAllStatements(
  args: unknown,
): Promise<ActionResult<{ deleted: number; unapproved: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteAllStatementsSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const period = await requireOpenPeriod(
      db,
      { companyId: input.companyId, start: input.periodStart, end: input.periodEnd },
      'unlock first',
    );

    const deleted = await dbDeleteAllStatements(db, period.id);
    const released = await releaseSessionsForDeletedStatements(db, period.id);
    const unapproved = await returnTimeToApproval(db, input.companyId, period.id);
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: `${input.periodStart} → ${input.periodEnd}`,
      detail: {
        scope: 'whole_period',
        count: deleted,
        released_sessions: released,
        unapproved_entries: unapproved,
      },
    });
    return { ok: true, data: { deleted, unapproved } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}

/* ---------- Process screen: fetch payments ---------- */

export async function getProcessPayments(args: {
  periodId: string;
  companyId: string;
}): Promise<ActionResult<{ payments: ProcessPayment[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const db = await createServerSupabase();
    const payments = await fetchProcessPayments(db, args.periodId);
    return { ok: true, data: { payments } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Lookup failed.'),
    };
  }
}

/* ---------- Mark paid / unpaid ---------- */

export async function markPaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkPaidSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // RP-52: /process only ROUTES to the pay panel for a locked/paid batch —
    // this action is an HTTP endpoint, so the state must be checked here too or
    // an open period's rows flip to 'sent' mid-calculation.
    const blocked = unpayablePeriodReason(await fetchPeriodStatesForPayments(db, input.paymentIds));
    if (blocked) return { ok: false, error: blocked };

    const paidAt = input.paidAt ?? new Date().toISOString();
    // RP-61: report what actually changed — RLS and the already-paid filter
    // (RP-08) both make this smaller than the requested id list.
    const markedCount = await markPaymentsPaid(db, input.paymentIds, paidAt);
    const paidPeriodIds = await fetchPeriodIdsForPayments(db, input.paymentIds);
    await Promise.all(paidPeriodIds.map((pid) => syncPeriodPaidState(db, pid)));
    await logEvent({
      companyId: input.companyId,
      action: 'mark_paid',
      entity: input.companyId,
      detail: {
        count: markedCount,
        requested: input.paymentIds.length,
        method: 'manual',
        paid_at: paidAt,
      },
    });
    revalidatePeriodViews();
    return { ok: true, data: { markedCount } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Mark paid failed.'),
    };
  }
}

/**
 * RP-53: the per-row `markUnpaid` action is DELETED, not guarded.
 *
 * It had zero callers in src/ — the "reverse this one payment" path the UI once
 * promised never existed (that copy has since been corrected), so every one of
 * its bugs was reachable only by hand-posting to the endpoint: no
 * `wise_locked_at` check and, unlike markAllUnpaid, no `wise_transfer_id`
 * filter, so it would happily flip a funded, actually-sent Wise payment back to
 * 'draft'. The `payments_lock_enforce` trigger does not protect
 * `status`/`paid_at`, so nothing downstream would have stopped it either.
 *
 * Deleting removes the endpoint outright rather than shipping a guarded action
 * nobody calls. Reversal is still available, wired and guarded, via
 * markAllUnpaid (which excludes Wise-transfer rows). If per-row reversal is ever
 * built, re-add it WITH the wise_locked_at / wise_transfer_id filters and the
 * period-state gate below.
 */

export async function markAllUnpaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkAllUnpaidSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // RP-52: an OPEN period has nothing to reverse, and stepPeriodToLocked below
    // would force it OUT of open — locking a draft mid-calculation.
    const blocked = unpayablePeriodReason([(await fetchPeriodState(db, input.periodId)) ?? 'open']);
    if (blocked) return { ok: false, error: blocked };

    // Only reverse non-wise-transfer rows (legacy: those with a Wise transfer need individual handling)
    const payments = await fetchProcessPayments(db, input.periodId);
    const toReverse = payments
      .filter((p) => p.status === 'sent' && !p.wiseTransferId)
      .map((p) => p.paymentId);
    if (toReverse.length > 0) {
      await markPaymentsUnpaid(db, toReverse);
      await stepPeriodToLocked(db, input.periodId);
    }
    await logEvent({
      companyId: input.companyId,
      action: 'mark_unpaid',
      entity: input.periodId,
      detail: { scope: 'all', count: toReverse.length },
    });
    revalidatePeriodViews();
    return { ok: true, data: { markedCount: toReverse.length } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Mark all unpaid failed.'),
    };
  }
}

/* ---------- Wise row lock ---------- */

export async function toggleWiseRowLock(
  args: unknown,
): Promise<ActionResult<{ lockedAt: string | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = ToggleWiseRowLockSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    // Unlocking (lockedAt = null) requires a reason
    if (input.lockedAt == null && !input.reason?.trim()) {
      return { ok: false, error: 'Unlock requires a reason.' };
    }
    await setWiseRowLock(db, input.paymentId, input.lockedAt ?? null);
    if (input.reason) {
      await logEvent({
        companyId: input.companyId,
        action: 'wise_lock_release',
        entity: input.paymentId,
        detail: { reason: input.reason },
      });
    }
    return { ok: true, data: { lockedAt: input.lockedAt ?? null } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Toggle lock failed.'),
    };
  }
}

/* ---------- Off-cycle per-session / per-hour pay ---------- */

export type OffCycleEligibleWorker = {
  workerId: string;
  name: string;
  basis: 'per_session' | 'per_hour';
};

/** Per-session / per-hour contractors on the company roster (off-cycle picker). */
export async function getOffCycleEligibleWorkers(args: {
  companyId: string;
}): Promise<ActionResult<{ workers: OffCycleEligibleWorker[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const workers: OffCycleEligibleWorker[] = [];
    for (const r of roster) {
      const model = payModelFor(r.contract, r.payBasis);
      if (model !== 'per_session' && model !== 'per_hour') continue;
      const name = [r.worker.firstName, r.worker.middleName, r.worker.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      workers.push({ workerId: r.workerId, name: name || r.workerId, basis: model });
    }
    workers.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, data: { workers } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

export type LockedPeriodSession = {
  sessionId: string;
  workerName: string;
  companyName: string;
  sessionDate: string;
  periodStart: string;
  periodEnd: string;
  periodState: 'locked' | 'paid';
};

/**
 * Of the given (just-approved) sessions, which fall in a LOCKED or PAID pay
 * period? Those won't be paid by Calculate (the period is frozen), so the
 * approve flow warns and offers to unlock that period / route off-cycle.
 */
export async function getSessionsInLockedPeriods(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ sessions: LockedPeriodSession[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  if (args.sessionIds.length === 0) return { ok: true, data: { sessions: [] } };
  try {
    const { data: rows, error } = await createServiceClient()
      .from('service_sessions')
      .select('id, session_date, companies(name), workers(first_name, last_name)')
      .in('id', args.sessionIds);
    if (error) throw new Error(error.message);

    const db = await createServerSupabase();
    const stateByRange = await fetchPeriodStatesByWindow(db, args.companyId);

    const out: LockedPeriodSession[] = [];
    for (const r of rows ?? []) {
      const p = periodFor(r.session_date);
      const state = stateByRange.get(`${p.start}|${p.end}`);
      if (state === 'locked' || state === 'paid') {
        out.push({
          sessionId: r.id,
          workerName:
            [r.workers?.first_name, r.workers?.last_name].filter(Boolean).join(' ').trim() || '—',
          companyName: r.companies?.name ?? '—',
          sessionDate: r.session_date,
          periodStart: p.start,
          periodEnd: p.end,
          periodState: state,
        });
      }
    }
    return { ok: true, data: { sessions: out } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/**
 * Most-recently-added sessions across the employer's per-session/per-hour
 * contractors — the always-visible "Recently added" list, so a just-entered
 * session is visible without re-picking its contractor.
 */
export async function getRecentSessions(args: {
  companyId: string;
  /** Period bounds — when set, scope the list to sessions dated within them.
   *  Omit (the "show all unpaid" toggle) to span every period. */
  start?: string;
  end?: string;
}): Promise<ActionResult<{ sessions: RecentSessionRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const workerIds = roster
      .filter((r) => {
        const m = payModelFor(r.contract, r.payBasis);
        return m === 'per_session' || m === 'per_hour';
      })
      .map((r) => r.workerId);
    // Service client + explicit worker-id scoping (sessions are CLIENT-company
    // RLS-scoped; we restrict to this employer's roster).
    const sessions = await fetchRecentSessionsForWorkers(createServiceClient(), workerIds, {
      ...(args.start && args.end ? { start: args.start, end: args.end } : {}),
    });
    return { ok: true, data: { sessions } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** A worker's approved, not-yet-paid sessions — the pick-mode checklist. */
export async function getUnpaidSessions(args: {
  companyId: string;
  workerId: string;
}): Promise<ActionResult<{ sessions: UnpaidSessionRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const sessions = await fetchUnpaidApprovedSessions(createServiceClient(), args.workerId);
    return { ok: true, data: { sessions } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** Existing off-cycle items for a worker on a period (modal list / remove). */
export async function getOffCycleItems(args: {
  companyId: string;
  periodId: string;
  workerId: string;
}): Promise<ActionResult<{ items: OffCycleItemRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const items = await fetchOffCycleItemsForWorkerPeriod(db, args.periodId, args.workerId);
    return { ok: true, data: { items } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** Add an off-cycle pay entry — see addOffCycleEntry in src/server/off-cycle.ts. */
export async function addOffCyclePayItem(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null; count: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddOffCyclePaySchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    return { ok: true, data: await addOffCycleEntry(input) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add off-cycle pay failed.') };
  }
}

/**
 * Salaried (FT/PT) catch-up candidates. No worker/date args → scan the most
 * recent locked/paid REGULAR period for every salaried worker (auto-detect);
 * with workerId + periodDate → single-worker quote for the manual form. Also
 * returns the salaried roster for the manual worker select.
 */
export async function getSalariedCatchUpCandidates(args: {
  companyId: string;
  workerId?: string;
  periodDate?: string;
}): Promise<
  ActionResult<{
    period: { id: string; periodStart: string; periodEnd: string } | null;
    candidates: CatchUpCandidate[];
    salariedWorkers: { workerId: string; name: string }[];
  }>
> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const roster = await fetchRoster(db, args.companyId);
    const salariedWorkers = roster
      .filter((r) => payModelFor(r.contract, r.payBasis) === 'salaried')
      .map((r) => ({
        workerId: r.workerId,
        name: [r.worker.firstName, r.worker.lastName].filter(Boolean).join(' ').trim(),
      }));

    let period: { id: string; periodStart: string; periodEnd: string } | null = null;
    let workerIds: string[] | undefined;
    if (args.periodDate) {
      const p = periodFor(args.periodDate);
      const found = await findPeriod(db, args.companyId, p.start, p.end);
      if (args.workerId) {
        // Manual-quote mode: a specific worker + period — hard errors so the
        // form can explain exactly why there's nothing to quote.
        if (!found)
          return {
            ok: false,
            error: 'That period was never run — its hours pay out via the regular Calculate.',
          };
        if (found.state === 'open')
          return {
            ok: false,
            error: 'That period is still open — recalculate it instead of adding a catch-up.',
          };
        period = { id: found.id, periodStart: p.start, periodEnd: p.end };
        workerIds = [args.workerId];
      } else if (found && found.state !== 'open' && found.kind === 'regular') {
        // Period-scan mode (Time page card): all salaried candidates for THIS
        // period. Open / never-run / off-cycle periods soft-return no period —
        // the caller simply renders nothing.
        period = { id: found.id, periodStart: p.start, periodEnd: p.end };
      }
    } else {
      // Newest-first summaries; the first finished regular run is the scan target.
      const sums = await fetchPeriodSummaries(db, args.companyId);
      const target = sums.find((s) => s.kind === 'regular' && s.state !== 'open');
      if (target)
        period = { id: target.id, periodStart: target.periodStart, periodEnd: target.periodEnd };
    }

    const candidates = period
      ? await salariedCatchUpCandidates({
          companyId: args.companyId,
          periodId: period.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          workerIds,
        })
      : [];
    return { ok: true, data: { period, candidates, salariedWorkers } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Lookup failed.') };
  }
}

/** Add a salaried catch-up — see addSalariedCatchUpEntry in src/server/off-cycle.ts. */
export async function addSalariedCatchUp(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null; amountPhp: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddSalariedCatchUpSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    return { ok: true, data: await addSalariedCatchUpEntry(input) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add catch-up pay failed.') };
  }
}

/** Approve → pay into the open draft — see paySessionsIntoOpenDraft in src/server/off-cycle.ts. */
export async function payApprovedSessions(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ paidInto: 'draft' | 'none'; count: number; periodStart?: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    return { ok: true, data: await paySessionsIntoOpenDraft(args) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add to draft failed.') };
  }
}

/** Pay into a scheduled (possibly future) period — see paySessionsIntoPeriod in src/server/off-cycle.ts. */
export async function payApprovedSessionsToNextPeriod(args: {
  companyId: string;
  sessionIds: string[];
  /** Canonical period start to pay in; defaults to the sessions' own period. */
  periodStart?: string;
}): Promise<ActionResult<{ count: number; periodStart: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    return { ok: true, data: await paySessionsIntoPeriod(args) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Add to next period failed.') };
  }
}

/** Pay now in the off-cycle batch — see paySessionsIntoOffCycleBatch in src/server/off-cycle.ts. */
export async function routeSessionsToOffCycleBatch(args: {
  companyId: string;
  sessionIds: string[];
}): Promise<ActionResult<{ batchId: string; count: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    return { ok: true, data: await paySessionsIntoOffCycleBatch(args) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Off-cycle batch failed.') };
  }
}

/** Direct /payroll entry: find-or-create the employer's single open off-cycle batch. */
export async function openOffCycleBatch(args: {
  companyId: string;
}): Promise<
  ActionResult<{ batchId: string; periodStart: string; periodEnd: string; isNew: boolean }>
> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    // RP-67: the batch label is the OFFICE's calendar day, not UTC's — after
    // ~8 PM in New York the UTC date is already tomorrow.
    const batch = await findOrCreateOffCycleBatch(db, args.companyId, officeToday());
    if (batch.isNew) {
      await logEvent({
        companyId: args.companyId,
        action: 'off_cycle_batch_open',
        entity: batch.id,
        detail: {},
      });
      revalidatePeriodViews();
    }
    return {
      ok: true,
      data: {
        batchId: batch.id,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        isNew: batch.isNew,
      },
    };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Off-cycle batch failed.') };
  }
}

/** Remove an off-cycle pay item — see removeOffCycleEntry in src/server/off-cycle.ts. */
export async function removeOffCyclePayItem(
  args: unknown,
): Promise<ActionResult<{ netPhp: number | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RemoveOffCyclePaySchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    return { ok: true, data: await removeOffCycleEntry(input) };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Remove off-cycle pay failed.'),
    };
  }
}
