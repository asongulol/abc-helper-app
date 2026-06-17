/**
 * Payroll service — fetch → compute → persist (NPM-Helper-App service pattern;
 * legacy `calculate()` orchestration without the React state).
 *
 * Uses the RLS user client; the caller (server action) must already have
 * verified the admin via getCurrentAdmin (ADR-0004 re-verification).
 */

import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import {
  fetchApprovedTime,
  fetchLastPayoutMethods,
  fetchRates,
  fetchRoster,
  findPeriod,
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
};

/**
 * Rebuild a period's statements purely from tracked hours and persist them as
 * DRAFT. Refuses to touch a locked/paid period. NOTE the legacy semantics this
 * preserves: recalculating discards manual overrides/adjustments — the UI layer
 * owns the warning + undo snapshot before invoking this.
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
  });

  const period = await upsertOpenPeriod(
    db,
    input.companyId,
    input.periodStart,
    input.periodEnd,
    input.payDate,
  );

  const drafts = rows
    .map((r) => toPaymentDraft(r, { fxRate: input.fxRate }))
    .filter((d): d is NonNullable<typeof d> => d !== null);
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
  };
};
