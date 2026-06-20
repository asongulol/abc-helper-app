/**
 * Payroll mappers — the glue between DB rows and the pure calc engine
 * (legacy `calculate()` steps 1–3: attribution, aggregation, row building).
 *
 * Pure module: plain-data in, plain-data out. Queries live in src/db/queries;
 * the orchestration lives in src/server/payroll.ts (fetch → compute → persist,
 * the NPM-Helper-App service pattern).
 *
 * Money boundary: DB numeric(12,2) columns are PHP major units; everything
 * inside the engine is integer centavos. Conversions happen ONLY here.
 */

import { type Centavos, majorToMinor } from '@/lib/money';
import { nameKey } from '@/lib/names';
import { type ContractorRowResult, calcContractorRow, type MiscItem } from '@/lib/pay/calc';
import type { Holiday } from '@/lib/pay/holidays';
import { type RateRow, resolveRate } from '@/lib/pay/rates';

/** Centavos → PHP major units for DB writes (numeric(12,2)). */
export const centavosToPhp = (value: Centavos): number => Number((value / 100).toFixed(2));

/* ---------- plain-data row shapes (decoupled from generated DB types) ---------- */

export type TimeEntryRow = {
  workerId: string | null;
  sourceName: string | null;
  workDate: string;
  trackedSeconds: number;
  ptoSeconds: number;
};

export type RosterRow = {
  workerId: string;
  contract: string;
  hubstaffName: string | null;
  linkStatus: string | null;
  worker: {
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    hireDate: string | null;
    status: string | null;
    payoutMethod: string | null;
    healthAllowanceEligible: boolean;
    thirteenthMonthEligible: boolean;
  };
};

export const fullName = (w: RosterRow['worker']): string =>
  [w.firstName, w.middleName, w.lastName].filter(Boolean).join(' ').trim();

/* ---------- attribution (legacy widByName + normName) ---------- */

export type AttributionResult = {
  /** Σ (tracked + pto) seconds per resolved worker. */
  secondsByWorker: Map<string, number>;
  /** Distinct work dates with any positive time, per worker. */
  daysByWorker: Map<string, Set<string>>;
  /** Approved rows whose contractor couldn't be resolved (source names). */
  unattributed: string[];
  /** Workers with approved time but no roster link in THIS company. */
  unlinkedWorkerIds: string[];
};

/**
 * Resolve every approved time entry to a worker and aggregate seconds.
 * Null `workerId` rows resolve by source name (exact, then normalized nameKey).
 * Nothing is silently dropped — unresolved rows are surfaced (legacy invariant).
 */
export const attributeTimeEntries = (
  entries: readonly TimeEntryRow[],
  roster: readonly RosterRow[],
): AttributionResult => {
  const idByName = new Map<string, string>();
  for (const link of roster) {
    const candidates = [link.hubstaffName, fullName(link.worker)].filter(
      (x): x is string => !!x && x.trim().length > 0,
    );
    for (const cand of candidates) {
      idByName.set(cand, link.workerId);
      idByName.set(nameKey(cand), link.workerId);
    }
  }
  const linked = new Set(roster.map((r) => r.workerId));

  const secondsByWorker = new Map<string, number>();
  const daysByWorker = new Map<string, Set<string>>();
  const unattributed = new Set<string>();
  const unlinked = new Set<string>();

  for (const t of entries) {
    const wid =
      t.workerId ??
      (t.sourceName
        ? (idByName.get(t.sourceName) ?? idByName.get(nameKey(t.sourceName)))
        : undefined);
    if (!wid) {
      unattributed.add(t.sourceName || '(no name)');
      continue;
    }
    if (!linked.has(wid)) {
      unlinked.add(wid);
      continue;
    }
    const secs = (Number(t.trackedSeconds) || 0) + (Number(t.ptoSeconds) || 0);
    secondsByWorker.set(wid, (secondsByWorker.get(wid) ?? 0) + secs);
    if (secs > 0) {
      const days = daysByWorker.get(wid) ?? new Set<string>();
      days.add(t.workDate);
      daysByWorker.set(wid, days);
    }
  }

  return {
    secondsByWorker,
    daysByWorker,
    unattributed: [...unattributed],
    unlinkedWorkerIds: [...unlinked],
  };
};

/* ---------- statement building ---------- */

export type StatementRow = {
  workerId: string;
  name: string;
  contract: string;
  payoutMethod: string | null;
  /** True when the worker or company link is no longer active (lock-time warning). */
  inactive: boolean;
  result: ContractorRowResult;
};

export type BuildStatementsArgs = {
  periodStart: string;
  periodEnd: string;
  attribution: AttributionResult;
  roster: readonly RosterRow[];
  /** Effective-dated rates for the company (PHP major units, as stored). */
  rates: readonly RateRow[];
  /** Most recent payout method previously used, per worker (fallback default). */
  lastPayoutMethod?: ReadonlyMap<string, string>;
  includeHealthAllowance?: boolean;
  includeThirteenth?: boolean;
  holidays?: readonly Holiday[];
  /** Σ approved session units in the period per worker (PS pay). */
  sessionsByWorker?: ReadonlyMap<string, number>;
};

/** One engine pass per attributed worker — the heart of legacy `calculate()`. */
export const buildStatements = (args: BuildStatementsArgs): StatementRow[] => {
  const byId = new Map(args.roster.map((r) => [r.workerId, r]));
  const out: StatementRow[] = [];
  const processed = new Set<string>();

  const build = (workerId: string, workedSeconds: number) => {
    const link = byId.get(workerId);
    if (!link) return; // already surfaced as unlinked by attribution
    const w = link.worker;
    const result = calcContractorRow({
      workedSeconds,
      sessionUnits: args.sessionsByWorker?.get(workerId) ?? 0,
      contract: link.contract,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      rate: resolveRate(args.rates, workerId, args.periodStart, args.periodEnd),
      hireDate: w.hireDate,
      healthAllowanceEligible: w.healthAllowanceEligible,
      thirteenthMonthEligible: w.thirteenthMonthEligible,
      includeHealthAllowance: args.includeHealthAllowance ?? true,
      includeThirteenth: args.includeThirteenth ?? true,
      ...(args.holidays !== undefined ? { holidays: args.holidays } : {}),
    });
    const inactive =
      (link.linkStatus !== null && link.linkStatus !== 'active') ||
      (w.status !== null && w.status !== 'active');
    out.push({
      workerId,
      name: fullName(w) || workerId,
      contract: link.contract,
      payoutMethod: w.payoutMethod ?? args.lastPayoutMethod?.get(workerId) ?? null,
      inactive,
      result,
    });
    processed.add(workerId);
  };

  // Time-driven workers (FT/PT/PH, and any PS who also tracked time) — unchanged.
  for (const [workerId, workedSeconds] of args.attribution.secondsByWorker) {
    build(workerId, workedSeconds);
  }
  // PS (per-session) workers are paid from sessions even with no tracked time,
  // so pull them in by their session activity. Only PS — never alters FT/PT/PH.
  if (args.sessionsByWorker) {
    for (const [workerId, units] of args.sessionsByWorker) {
      if (processed.has(workerId) || units <= 0) continue;
      if (byId.get(workerId)?.contract !== 'PS') continue;
      build(workerId, 0);
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

/* ---------- payments persistence shape ---------- */

export type PaymentDraft = {
  worker_id: string;
  expected_hours: number;
  worked_hours: number;
  performance_ratio: number;
  rate_php: number | null;
  gross_php: number;
  health_allowance_php: number;
  thirteenth_month_php: number;
  pdd_lunch_php: number;
  bonus_php: number;
  /** Informational performance shortfall (rate − gross); NOT subtracted from net. */
  shortfall_php: number;
  net_php: number;
  misc_items: MiscItem[];
  fx_rate: number | null;
  payout_currency: 'PHP';
  payout_amount: number;
  payout_method: string | null;
  status: 'draft';
};

/**
 * Engine result → payments row values (PHP major units, legacy storage
 * rounding preserved: worked 2 dp, ratio 4 dp). Rows with a null net (no
 * rate) are NOT persisted — callers must filter (legacy invariant).
 */
export const toPaymentDraft = (
  row: StatementRow,
  opts: { fxRate?: number | undefined },
): PaymentDraft | null => {
  const r = row.result;
  if (r.net === null || r.gross === null) return null;
  // The resolved rate is carried on the result: per-period (FT/PT) or per-unit
  // (PH/PS). For FT/PT it equals gross + shortfall, so stored rate_php is
  // unchanged (parity); for PH/PS it's the per-hour / per-session rate.
  const ratePhp = r.rate === null ? null : centavosToPhp(r.rate);
  return {
    worker_id: row.workerId,
    expected_hours: r.expectedHours,
    worked_hours: Number(r.workedHours.toFixed(2)),
    performance_ratio: Number(r.ratio.toFixed(4)),
    rate_php: ratePhp,
    gross_php: centavosToPhp(r.gross),
    health_allowance_php: centavosToPhp(r.healthAllowance),
    thirteenth_month_php: centavosToPhp(r.thirteenth),
    pdd_lunch_php: centavosToPhp(r.pddLunch),
    bonus_php: centavosToPhp(r.bonus),
    shortfall_php: centavosToPhp(r.shortfall),
    net_php: centavosToPhp(r.net),
    misc_items: [],
    fx_rate: opts.fxRate ?? null,
    payout_currency: 'PHP',
    payout_amount: centavosToPhp(r.net),
    payout_method: row.payoutMethod,
    status: 'draft',
  };
};

/** Convenience for reading PHP major-unit numerics into the engine domain. */
export const phpToCentavos = (php: number | string | null): Centavos | null =>
  php == null ? null : (majorToMinor(Number(php)) as Centavos);
