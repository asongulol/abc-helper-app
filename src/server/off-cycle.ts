/**
 * Off-cycle ledger service — the one recipe for paying outside a period's
 * window: validate → insert ledger rows (the DB unique indexes are the hard
 * double-pay guard) → stamp picked sessions paid → rebuild the worker's draft
 * row → audit log. The server actions are thin wrappers (auth + Zod +
 * humanizeError); domain refusals throw with the user-facing copy.
 *
 * Uses the PayrollDeps seam (tests pass the in-memory fake); the caller must
 * already have verified the admin via getCurrentAdmin (ADR-0004).
 */

import 'server-only';
import {
  fetchRates,
  fetchRoster,
  insertOffCycleItems,
  markSessionsPaid,
  type NewOffCycleItem,
  requireOpenPeriod,
} from '@/db/queries/payroll';
import { fetchSessionsByIds } from '@/db/queries/sessions';
import { mulRatioMinor } from '@/lib/money';
import { payModelFor } from '@/lib/pay/expected-hours';
import { resolveRate } from '@/lib/pay/rates';
import { centavosToPhp } from '@/lib/payroll/mappers';
import { logEvent } from '@/server/audit';
import { type PayrollDeps, realDeps, recomputeWorkerDraft } from '@/server/payroll';
import type { AddOffCyclePayInput } from '@/types/schemas/payroll';

/**
 * Add an off-cycle pay entry (pick existing approved sessions, or a manual
 * date+units+description) to a per-session/per-hour contractor's row on the
 * (open) period. The session/work date need NOT fall in the period window. The
 * DB unique indexes are the hard double-pay guard; picked sessions are marked
 * paid so they leave the picker and the normal windowed sum. The worker's draft
 * row is then recomputed (gross excludes the now-paid sessions; the off-cycle
 * total is re-applied from the ledger so it survives later recalcs).
 */
export const addOffCycleEntry = async (
  input: AddOffCyclePayInput,
  deps?: PayrollDeps,
): Promise<{ netPhp: number | null; count: number }> => {
  const resolved = deps ?? (await realDeps());
  const { db, serviceDb } = resolved;

  // Resolve the target period — must be open (money columns freeze otherwise).
  const period = await requireOpenPeriod(
    db,
    {
      companyId: input.companyId,
      start: input.periodStart,
      end: input.periodEnd,
      create: 'missing',
    },
    'unlock it to add off-cycle pay',
  );

  // Worker must be on the employer roster and paid per-session/per-hour.
  const roster = await fetchRoster(db, input.companyId);
  const link = roster.find((r) => r.workerId === input.workerId);
  if (!link) throw new Error("Contractor is not on this company's roster.");
  const model = payModelFor(link.contract, link.payBasis);
  if (model === 'salaried')
    throw new Error('Off-cycle pay is only for per-session / per-hour contractors.');
  if (model === 'unset')
    throw new Error("Set the contractor's pay basis (hourly / per session) first.");
  if (model !== input.basis)
    throw new Error(
      `This contractor is paid ${model.replace('_', '-')}, not ${input.basis.replace('_', '-')}.`,
    );

  const rates = await fetchRates(db, input.companyId);
  const rows: NewOffCycleItem[] = [];
  const sessionIdsToMark: string[] = [];

  if (input.mode === 'pick') {
    const ids = input.sessionIds ?? [];
    const sessions = await fetchSessionsByIds(serviceDb, ids);
    if (sessions.length !== ids.length) throw new Error('One or more sessions were not found.');
    for (const s of sessions) {
      if (s.workerId !== input.workerId)
        throw new Error('A selected session belongs to another contractor.');
      if (s.approval !== 'approved') throw new Error('Only approved sessions can be paid.');
      if (s.paidAt) throw new Error('A selected session has already been paid.');
      const rate = resolveRate(rates, input.workerId, s.sessionDate, s.sessionDate);
      if (rate === null) throw new Error(`No rate is set for ${s.sessionDate}. Set a rate first.`);
      rows.push({
        companyId: input.companyId,
        workerId: input.workerId,
        payPeriodId: period.id,
        basis: 'per_session',
        sessionId: s.id,
        workDate: s.sessionDate,
        units: s.units,
        ratePhp: centavosToPhp(rate),
        amountPhp: centavosToPhp(mulRatioMinor(rate, s.units)),
        description: input.description,
      });
      sessionIdsToMark.push(s.id);
    }
  } else {
    const workDate = input.workDate as string;
    const rate = resolveRate(rates, input.workerId, workDate, workDate);
    let amountPhp: number;
    if (input.amountPhp != null) {
      amountPhp = input.amountPhp;
    } else {
      if (rate === null)
        throw new Error(`No rate is set for ${workDate}. Set a rate or enter an amount.`);
      amountPhp = centavosToPhp(mulRatioMinor(rate, input.units ?? 0));
    }
    rows.push({
      companyId: input.companyId,
      workerId: input.workerId,
      payPeriodId: period.id,
      basis: input.basis,
      sessionId: null,
      workDate,
      units: input.units ?? null,
      ratePhp: rate === null ? null : centavosToPhp(rate),
      amountPhp,
      description: input.description,
    });
  }

  // Insert — the unique indexes reject a double-pay (session_id or worker+date).
  try {
    await insertOffCycleItems(db, rows);
  } catch (e) {
    if (e instanceof Error && e.message === 'ALREADY_PAID')
      throw new Error(
        input.mode === 'pick'
          ? 'That session has already been paid.'
          : 'An off-cycle entry already exists for this contractor on that date.',
      );
    throw e;
  }

  if (sessionIdsToMark.length > 0) {
    await markSessionsPaid(serviceDb, sessionIdsToMark, period.id, null, new Date().toISOString());
  }

  const { netPhp } = await recomputeWorkerDraft(
    {
      companyId: input.companyId,
      periodId: period.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      workerId: input.workerId,
      offCycleOnly: period.kind === 'off_cycle',
    },
    resolved,
  );

  await logEvent({
    companyId: input.companyId,
    action: 'add_off_cycle',
    entity: input.workerId,
    detail: {
      basis: input.basis,
      mode: input.mode,
      count: rows.length,
      amount_php: rows.reduce((s, r) => s + r.amountPhp, 0),
      period: `${input.periodStart} → ${input.periodEnd}`,
    },
  });

  return { netPhp, count: rows.length };
};
