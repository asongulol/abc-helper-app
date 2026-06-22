/**
 * Payroll service — fetch → compute → persist (NPM-Helper-App service pattern;
 * legacy `calculate()` orchestration without the React state).
 *
 * Uses the RLS user client; the caller (server action) must already have
 * verified the admin via getCurrentAdmin (ADR-0004 re-verification).
 */

import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import {
  fetchApprovedTime,
  fetchLastPayoutMethods,
  fetchPaymentRowsForRestore,
  fetchRates,
  fetchRoster,
  fetchSessionUnitsByWorkerByDate,
  findPeriod,
  type PaymentSnapshotRow,
  pruneDraftPaymentsExcept,
  upsertDraftPayments,
  upsertOpenPeriod,
} from '@/db/queries/payroll';
import {
  attributeTimeEntries,
  buildStatements,
  type StatementRow,
  toPaymentDraft,
} from '@/lib/payroll/mappers';
import { logEvent } from '@/server/audit';
import type { CalculateDraftInput } from '@/types/schemas/payroll';

export type CalculateDraftResult = {
  periodId: string;
  rows: StatementRow[];
  /** Names whose approved time couldn't be matched to a contractor (legacy warning). */
  unattributed: string[];
  /** Workers with approved time but no link in this company (legacy warning). */
  unlinkedWorkerIds: string[];
  /** Rows skipped from persistence because the worker has no rate (net null). */
  skippedNoRate: string[];
  /**
   * F6: the period's payment rows as they were BEFORE this recalc (verbatim),
   * so the UI can offer an Undo that restores manual overrides/adjustments the
   * recalc discarded. Empty on a first calculate.
   */
  priorSnapshot: PaymentSnapshotRow[];
};

/**
 * Rebuild a period's statements purely from tracked hours and persist them as
 * DRAFT. Refuses to touch a locked/paid period. Recalculating discards manual
 * overrides/adjustments for rebuilt rows and prunes rows whose worker no longer
 * has approved time (F5); the UI owns the typed-word warning, and the prior rows
 * are returned as `priorSnapshot` so the caller can offer an Undo (F6).
 */
export const calculateDraft = async (input: CalculateDraftInput): Promise<CalculateDraftResult> => {
  const db = await createServerSupabase();

  const existing = await findPeriod(db, input.companyId, input.periodStart, input.periodEnd);
  if (existing && existing.state !== 'open') {
    throw new Error(`Period is ${existing.state} — unlock it before recalculating.`);
  }

  const [entries, roster, rates, lastMethod] = await Promise.all([
    fetchApprovedTime(db, input.companyId, input.periodStart, input.periodEnd),
    fetchRoster(db, input.companyId),
    fetchRates(db, input.companyId),
    fetchLastPayoutMethods(db, input.companyId),
  ]);

  // Per-session (PS) providers are paid by approved session count, not time.
  // service_sessions belong to CLIENT companies, so they're invisible under the
  // RLS user client to an admin scoped only to the employer. Payroll is
  // employer-side and must see ALL of a worker's approved client sessions
  // regardless of which admin runs it — read via the service role behind the
  // caller's already-verified admin identity (ADR-0004; see src/server/company.ts).
  const sessionUnitsByWorkerByDate = await fetchSessionUnitsByWorkerByDate(
    createServiceClient(),
    roster.map((r) => r.workerId),
    input.periodStart,
    input.periodEnd,
  );
  // Per-worker totals derived from the date buckets (PS gross + PS-only build).
  const sessionsByWorker = new Map<string, number>();
  for (const [workerId, byDate] of sessionUnitsByWorkerByDate) {
    let total = 0;
    for (const units of byDate.values()) total += units;
    sessionsByWorker.set(workerId, total);
  }

  const attribution = attributeTimeEntries(entries, roster);
  const rows = buildStatements({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    attribution,
    roster,
    rates,
    lastPayoutMethod: lastMethod,
    includeHealthAllowance: input.includeHealthAllowance,
    includeThirteenth: input.includeThirteenth,
    sessionsByWorker,
    sessionUnitsByWorkerByDate,
  });

  const period = await upsertOpenPeriod(
    db,
    input.companyId,
    input.periodStart,
    input.periodEnd,
    input.payDate,
  );

  // F6: snapshot the prior rows (incl. manual overrides) before we overwrite
  // them, so the caller can offer an Undo. Captured after upsertOpenPeriod so
  // period.id is known; before prune/upsert so the old values are still present.
  const priorSnapshot = await fetchPaymentRowsForRestore(db, period.id);

  const drafts = rows
    .map((r) => toPaymentDraft(r, { fxRate: input.fxRate }))
    .filter((d): d is NonNullable<typeof d> => d !== null);

  // F5: recalc is authoritative for an OPEN period — remove payment rows for
  // workers no longer in the result (their approved time was retracted) so a
  // stale row can't be locked/paid. Runs before the upsert; the period is
  // guaranteed open by the guard above.
  await pruneDraftPaymentsExcept(
    db,
    period.id,
    drafts.map((d) => d.worker_id),
  );

  await upsertDraftPayments(db, input.companyId, period.id, drafts);

  await logEvent({
    companyId: input.companyId,
    action: 'recalculate',
    entity: `${input.periodStart} → ${input.periodEnd}`,
    detail: { rows: rows.length, persisted: drafts.length },
  });

  return {
    periodId: period.id,
    rows,
    unattributed: attribution.unattributed,
    unlinkedWorkerIds: attribution.unlinkedWorkerIds,
    skippedNoRate: rows.filter((r) => r.result.net === null).map((r) => r.name),
    priorSnapshot,
  };
};
