'use server';

/**
 * Payroll server actions — WIRED (the Phase-2 pattern-setters).
 * Flow per action: verify admin (re-verification at point of use, ADR-0004) →
 * Zod-validate input → query module / service → audit log. No inline SQL,
 * no money math here — that lives in src/lib (pure) and src/db/queries.
 */

import { createServerSupabase } from '@/db/clients/server';
import {
  deleteAllStatements as dbDeleteAllStatements,
  deleteStatement as dbDeleteStatement,
  lockPeriod as dbLockPeriod,
  unlockPeriod as dbUnlockPeriod,
  fetchPeriodSummaries,
  fetchProcessPayments,
  fetchSavedPayments,
  findPeriod,
  markPaymentsPaid,
  markPaymentsUnpaid,
  setWiseRowLock,
  stepPeriodToLocked,
  updatePaymentRow,
} from '@/db/queries/payroll';
import type { PeriodSummaryRow, ProcessPayment, SavedPayment } from '@/db/queries/payroll';
import { executeRateUpsert, fetchRateHistory } from '@/db/queries/rates';
import type { RateHistoryRow } from '@/db/queries/rates';
import { centavos, sumMinor } from '@/lib/money';
import type { MiscItem } from '@/lib/pay/calc';
import { miscTotal } from '@/lib/pay/calc';
import { centavosToPhp, phpToCentavos } from '@/lib/payroll/mappers';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { type CalculateDraftResult, calculateDraft } from '@/server/payroll';
import {
  CalculateDraftSchema,
  DeleteAllStatementsSchema,
  DeleteStatementSchema,
  LockPeriodSchema,
  MarkAllUnpaidSchema,
  MarkPaidSchema,
  MarkUnpaidSchema,
  RateSaveSchema,
  ToggleWiseRowLockSchema,
  UnlockPeriodSchema,
  UpdatePaymentRowSchema,
} from '@/types/schemas/payroll';

/**
 * Effective-dated rate save (legacy `saveRate`). Same-day saves replace;
 * earlier open rates are closed; the change is audit-logged from→to.
 */
export async function saveRate(args: unknown): Promise<ActionResult<{ kind: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = RateSaveSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
    return { ok: false, error: err instanceof Error ? err.message : 'Rate save failed.' };
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
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const result = await calculateDraft(input);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Calculate failed.' };
  }
}

/* ---------- Period summaries (batch list) ---------- */

export async function getPeriodSummaries(args: { companyId: string }): Promise<
  ActionResult<{ periods: PeriodSummaryRow[] }>
> {
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
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
  }
}

/* ---------- Saved payments for the editable draft table ---------- */

export async function getSavedPayments(args: { periodId: string; companyId: string }): Promise<
  ActionResult<{ payments: SavedPayment[] }>
> {
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
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
  }
}

/* ---------- Lock period ---------- */

/**
 * Lock a pay period. Blocks if any payment has null net (no rate) — returns
 * their names in `noRateNames`. When `confirmed=true` the caller has already
 * acknowledged no-method / inactive warnings.
 */
export async function lockPeriod(
  args: unknown,
): Promise<ActionResult<{ noRateNames?: string[]; lockedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = LockPeriodSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const period = await findPeriod(db, input.companyId, input.periodStart, input.periodEnd);
    if (!period) return { ok: false, error: 'Period not found.' };
    if (period.state !== 'open') return { ok: false, error: `Period is already ${period.state}.` };

    const payments = await fetchSavedPayments(db, period.id);
    const noRate = payments.filter((p) => p.netPhp == null);
    if (noRate.length > 0) {
      const names = noRate.map((p) => p.name).join(', ');
      return {
        ok: false,
        error: `${noRate.length} contractor(s) have no rate and cannot be locked: ${names}`,
      };
    }

    await dbLockPeriod(db, period.id, input.periodEnd);
    const validCount = payments.filter((p) => p.netPhp != null).length;

    await logEvent({
      companyId: input.companyId,
      action: 'lock',
      entity: `${input.periodStart} → ${input.periodEnd}`,
      detail: { contractors: validCount },
    });

    return { ok: true, data: { lockedCount: validCount } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Lock failed.' };
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const period = await findPeriod(db, input.companyId, input.periodStart, input.periodEnd);
    if (!period) return { ok: false, error: 'Period not found.' };
    if (period.state === 'paid')
      return { ok: false, error: 'Period is paid — mark all unpaid first.' };
    if (period.state !== 'locked')
      return { ok: false, error: `Period is not locked (state: ${period.state}).` };

    await dbUnlockPeriod(db, period.id);

    await logEvent({
      companyId: input.companyId,
      action: 'unlock_period',
      entity: `${input.periodStart} → ${input.periodEnd}`,
      detail: { reason: input.reason, previous_state: period.state },
    });

    return { ok: true, data: { periodStart: input.periodStart, periodEnd: input.periodEnd } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unlock failed.' };
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
        'gross_php, health_allowance_php, thirteenth_month_php, pdd_lunch_php, bonus_php, misc_items, net_php, note, pay_period_id',
      )
      .eq('id', input.paymentId)
      .maybeSingle();
    if (fe || !cur) return { ok: false, error: 'Payment not found.' };

    // Verify period is open
    const { data: pp } = await db
      .from('pay_periods')
      .select('state, company_id')
      .eq('id', cur.pay_period_id)
      .maybeSingle();
    if (!pp || pp.company_id !== input.companyId)
      return { ok: false, error: 'Payment not in this company.' };
    if (pp.state !== 'open') return { ok: false, error: 'Period is not open for editing.' };

    // Determine new field values
    const grossCur = phpToCentavos(cur.gross_php) ?? centavos(0);
    const grossNew =
      'grossPhpOverride' in input && input.grossPhpOverride != null
        ? (phpToCentavos(input.grossPhpOverride) ?? grossCur)
        : grossCur;

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

    // Recompute net via same composition as the engine (single-currency sum).
    const miscC = miscTotal(miscItemsNew);
    const netC = sumMinor([grossNew, haNew, t13New, pddNew, bonusNew, miscC]);
    const netPhp = centavosToPhp(netC);

    // Build note for gross override
    let note = cur.note ?? null;
    if ('grossPhpOverride' in input) {
      if (input.grossPhpOverride != null) {
        const computedGross = centavosToPhp(grossCur);
        note = `Gross manually overridden (computed ${computedGross})`;
      } else {
        note = null;
      }
    }

    await updatePaymentRow(db, input.paymentId, {
      ...('grossPhpOverride' in input
        ? {
            grossPhp:
              input.grossPhpOverride != null ? centavosToPhp(grossNew) : centavosToPhp(grossCur),
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
      note,
    });

    return { ok: true, data: { netPhp } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Update failed.' };
  }
}

/* ---------- Delete statement(s) ---------- */

export async function deleteStatement(args: unknown): Promise<ActionResult<{ deleted: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteStatementSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    await dbDeleteStatement(db, input.paymentId);
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: input.paymentId,
      detail: { scope: 'contractor' },
    });
    return { ok: true, data: { deleted: 1 } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed.' };
  }
}

export async function deleteAllStatements(
  args: unknown,
): Promise<ActionResult<{ deleted: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DeleteAllStatementsSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const period = await findPeriod(db, input.companyId, input.periodStart, input.periodEnd);
    if (!period) return { ok: false, error: 'Period not found.' };
    if (period.state !== 'open')
      return { ok: false, error: `Period is ${period.state} — unlock first.` };

    const deleted = await dbDeleteAllStatements(db, period.id);
    await logEvent({
      companyId: input.companyId,
      action: 'delete_statement',
      entity: `${input.periodStart} → ${input.periodEnd}`,
      detail: { scope: 'whole_period', count: deleted },
    });
    return { ok: true, data: { deleted } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed.' };
  }
}

/* ---------- Process screen: fetch payments ---------- */

export async function getProcessPayments(args: { periodId: string; companyId: string }): Promise<
  ActionResult<{ payments: ProcessPayment[] }>
> {
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
    return { ok: false, error: err instanceof Error ? err.message : 'Lookup failed.' };
  }
}

/* ---------- Mark paid / unpaid ---------- */

export async function markPaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkPaidSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const paidAt = input.paidAt ?? new Date().toISOString();
    await markPaymentsPaid(db, input.paymentIds, paidAt);
    await logEvent({
      companyId: input.companyId,
      action: 'mark_paid',
      entity: input.companyId,
      detail: { count: input.paymentIds.length, method: 'manual', paid_at: paidAt },
    });
    return { ok: true, data: { markedCount: input.paymentIds.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Mark paid failed.' };
  }
}

export async function markUnpaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkUnpaidSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    await markPaymentsUnpaid(db, input.paymentIds);
    await logEvent({
      companyId: input.companyId,
      action: 'mark_unpaid',
      entity: input.companyId,
      detail: { count: input.paymentIds.length },
    });
    return { ok: true, data: { markedCount: input.paymentIds.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Mark unpaid failed.' };
  }
}

export async function markAllUnpaid(args: unknown): Promise<ActionResult<{ markedCount: number }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = MarkAllUnpaidSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
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
    return { ok: true, data: { markedCount: toReverse.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Mark all unpaid failed.' };
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
    return { ok: false, error: err instanceof Error ? err.message : 'Toggle lock failed.' };
  }
}
