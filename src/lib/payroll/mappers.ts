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

import { addMinor, type Centavos, majorToMinor, mulRatioMinor, zeroCentavos } from '@/lib/money';
import { healthAllowance } from '@/lib/pay/allowances';
import { type ContractorRowResult, calcContractorRow, type MiscItem } from '@/lib/pay/calc';
import { payModelFor } from '@/lib/pay/expected-hours';
import type { Holiday } from '@/lib/pay/holidays';
import { type RateRow, resolveRate } from '@/lib/pay/rates';
import { buildMatchIndex, matchName } from '@/lib/time/attribution';

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
  /** worker_companies.pay_basis — 'hourly' | 'per_session' for a PHS engagement,
   *  else null. Drives per-unit pay for the shared-prod PHS contract type. */
  payBasis: string | null;
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
  /** Σ (tracked + pto) seconds per resolved worker, broken down by work_date.
   *  Used by the date-aware PH gross (F4) when a rate change lands mid-period. */
  secondsByWorkerByDate: Map<string, Map<string, number>>;
  /** Distinct work dates with any positive time, per worker. */
  daysByWorker: Map<string, Set<string>>;
  /** Approved rows whose contractor couldn't be resolved (source names). */
  unattributed: string[];
  /** Workers with approved time but no roster link in THIS company. */
  unlinkedWorkerIds: string[];
};

/**
 * Resolve every approved time entry to a worker and aggregate seconds.
 * Null `workerId` rows resolve by source name via the SHARED matcher
 * (src/lib/time/attribution.ts) — strict nameKey then loose first+last — so
 * calc-time attribution matches import-time exactly (audit 03 §3: the old local
 * matcher lacked the loose fallback, dropping loosely-matched workers to
 * `unattributed`). Nothing is silently dropped — unresolved rows are surfaced.
 */
export const attributeTimeEntries = (
  entries: readonly TimeEntryRow[],
  roster: readonly RosterRow[],
  /** (worker → work_dates) already paid via a per_hour off-cycle item — those
   *  days' hours are dropped here so they aren't ALSO paid by the windowed sum. */
  excludeDatesByWorker?: ReadonlyMap<string, ReadonlySet<string>>,
): AttributionResult => {
  const idx = buildMatchIndex(
    roster.map((r) => ({
      workerId: r.workerId,
      hubstaffName: r.hubstaffName,
      firstName: r.worker.firstName,
      middleName: r.worker.middleName,
      lastName: r.worker.lastName,
      // calc-time uses the `linked` set below for company scoping, not this flag.
      isInactive: false,
    })),
  );
  const linked = new Set(roster.map((r) => r.workerId));

  const secondsByWorker = new Map<string, number>();
  const secondsByWorkerByDate = new Map<string, Map<string, number>>();
  const daysByWorker = new Map<string, Set<string>>();
  const unattributed = new Set<string>();
  const unlinked = new Set<string>();

  for (const t of entries) {
    const wid =
      t.workerId ??
      (t.sourceName ? (matchName(t.sourceName, idx)?.workerId ?? undefined) : undefined);
    if (!wid) {
      unattributed.add(t.sourceName || '(no name)');
      continue;
    }
    if (!linked.has(wid)) {
      unlinked.add(wid);
      continue;
    }
    // Drop a day already paid via a per_hour off-cycle item (no double-pay).
    if (excludeDatesByWorker?.get(wid)?.has(t.workDate)) continue;
    const secs = (Number(t.trackedSeconds) || 0) + (Number(t.ptoSeconds) || 0);
    secondsByWorker.set(wid, (secondsByWorker.get(wid) ?? 0) + secs);
    const byDate = secondsByWorkerByDate.get(wid) ?? new Map<string, number>();
    byDate.set(t.workDate, (byDate.get(t.workDate) ?? 0) + secs);
    secondsByWorkerByDate.set(wid, byDate);
    if (secs > 0) {
      const days = daysByWorker.get(wid) ?? new Set<string>();
      days.add(t.workDate);
      daysByWorker.set(wid, days);
    }
  }

  return {
    secondsByWorker,
    secondsByWorkerByDate,
    daysByWorker,
    unattributed: [...unattributed],
    unlinkedWorkerIds: [...unlinked],
  };
};

/**
 * F4: date-aware per-unit gross for PH/PS. Sums Σ rate(date) × units(date)
 * ONLY when the worker has ≥2 distinct non-null rates across the dates worked
 * (a genuine mid-period rate change). Returns undefined in every other case so
 * the engine falls back to its single-rate `rate × totalUnits` product
 * (byte-for-byte parity). `unitsByDate` is HOURS per date for PH, session units
 * per date for PS.
 */
const dateAwarePerUnitGross = (
  rates: readonly RateRow[],
  workerId: string,
  unitsByDate: ReadonlyMap<string, number> | undefined,
): Centavos | undefined => {
  if (!unitsByDate || unitsByDate.size === 0) return undefined;
  const distinct = new Set<number>();
  let total = zeroCentavos();
  for (const [date, units] of unitsByDate) {
    if (!(units > 0)) continue;
    const r = resolveRate(rates, workerId, date, date);
    if (r === null) return undefined; // partial-null ⇒ defer to single-rate behavior
    distinct.add(r);
    total = addMinor(total, mulRatioMinor(r, units));
  }
  return distinct.size >= 2 ? total : undefined;
};

/* ---------- statement building ---------- */

export type StatementRow = {
  workerId: string;
  name: string;
  contract: string;
  /** PHS pay_basis ('hourly' | 'per_session') or null — carried to the payment snapshot. */
  payBasis: string | null;
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
  /** Approved session units per worker broken down by session_date (PS) — used
   *  by the date-aware gross (F4) when a rate change lands mid-period. */
  sessionUnitsByWorkerByDate?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Off-cycle per-session/per-hour earnings per worker (centavos), re-applied
   *  from the durable off_cycle_pay_items ledger so the line survives recalc. */
  offCycleByWorker?: ReadonlyMap<string, Centavos>;
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
    // F4: for per-unit work, compute a date-aware gross when the rate changed
    // mid-period (otherwise undefined → engine uses the single-rate product,
    // parity). per_hour uses hours-by-date; per_session uses session-units-by-date.
    const model = payModelFor(link.contract, link.payBasis);
    let perUnitGrossOverride: Centavos | undefined;
    if (model === 'per_hour') {
      const secsByDate = args.attribution.secondsByWorkerByDate.get(workerId);
      const hoursByDate = secsByDate
        ? new Map([...secsByDate].map(([d, s]) => [d, s / 3600]))
        : undefined;
      perUnitGrossOverride = dateAwarePerUnitGross(args.rates, workerId, hoursByDate);
    } else if (model === 'per_session') {
      perUnitGrossOverride = dateAwarePerUnitGross(
        args.rates,
        workerId,
        args.sessionUnitsByWorkerByDate?.get(workerId),
      );
    }
    const offCycleEarnings = args.offCycleByWorker?.get(workerId);
    const result = calcContractorRow({
      workedSeconds,
      sessionUnits: args.sessionsByWorker?.get(workerId) ?? 0,
      contract: link.contract,
      payBasis: link.payBasis,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      rate: resolveRate(args.rates, workerId, args.periodStart, args.periodEnd),
      ...(perUnitGrossOverride !== undefined ? { perUnitGrossOverride } : {}),
      hireDate: w.hireDate,
      healthAllowanceEligible: w.healthAllowanceEligible,
      thirteenthMonthEligible: w.thirteenthMonthEligible,
      includeHealthAllowance: args.includeHealthAllowance ?? true,
      includeThirteenth: args.includeThirteenth ?? true,
      ...(args.holidays !== undefined ? { holidays: args.holidays } : {}),
      ...(offCycleEarnings !== undefined ? { offCycleEarnings } : {}),
    });
    const inactive =
      (link.linkStatus !== null && link.linkStatus !== 'active') ||
      (w.status !== null && w.status !== 'active');
    out.push({
      workerId,
      name: fullName(w) || workerId,
      contract: link.contract,
      payBasis: link.payBasis,
      payoutMethod: w.payoutMethod ?? args.lastPayoutMethod?.get(workerId) ?? null,
      inactive,
      result,
    });
    processed.add(workerId);
  };

  // Time-driven workers (salaried + per_hour, and any per_session who also
  // tracked time) — unchanged.
  for (const [workerId, workedSeconds] of args.attribution.secondsByWorker) {
    build(workerId, workedSeconds);
  }
  // Per-session workers (legacy PS, or PHS + pay_basis='per_session') are paid
  // from sessions even with no tracked time, so pull them in by their session
  // activity. Only per_session — never alters salaried/per_hour.
  if (args.sessionsByWorker) {
    for (const [workerId, units] of args.sessionsByWorker) {
      if (processed.has(workerId) || units <= 0) continue;
      const lk = byId.get(workerId);
      if (!lk || payModelFor(lk.contract, lk.payBasis) !== 'per_session') continue;
      build(workerId, 0);
    }
  }
  // A worker whose ONLY activity this period is an off-cycle pay item (no
  // tracked time, no in-window sessions) still needs a statement row to carry
  // the off-cycle earnings. Pull them in by their ledger presence.
  if (args.offCycleByWorker) {
    for (const [workerId, amount] of args.offCycleByWorker) {
      if (processed.has(workerId) || amount <= 0) continue;
      if (!byId.has(workerId)) continue; // not on this company's roster
      build(workerId, 0);
    }
  }
  // F7: an HA-eligible worker whose hire anniversary lands in THIS period must
  // get a statement row even with zero approved time — otherwise the once-a-year
  // ₱20k health allowance is silently lost (no carry-forward). calcContractorRow
  // pays HA on a zero-time row (gross 0 + HA) as long as the worker has a rate.
  if (args.includeHealthAllowance ?? true) {
    for (const r of args.roster) {
      if (processed.has(r.workerId)) continue;
      if (!r.worker.healthAllowanceEligible) continue;
      if (healthAllowance(r.worker.hireDate, args.periodStart, args.periodEnd) <= 0) continue;
      build(r.workerId, 0);
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

/* ---------- payments persistence shape ---------- */

export type PaymentDraft = {
  worker_id: string;
  /** Contract + pay_basis written onto the payment row (shared-prod columns) to
   *  record the pay basis at the time of the recalc. NOTE: unlike the money
   *  columns, these are NOT in the lock-enforce trigger's protected set, so they
   *  are not frozen on a locked row — treat them as last-recalc, not immutable. */
  contract: string;
  pay_basis: string | null;
  /** Approved session count for a per_session row (prod parity), null otherwise. */
  units: number | null;
  expected_hours: number;
  worked_hours: number;
  performance_ratio: number;
  rate_php: number | null;
  gross_php: number;
  health_allowance_php: number;
  thirteenth_month_php: number;
  pdd_lunch_php: number;
  bonus_php: number;
  /**
   * Informational performance shortfall (rate − gross); NOT subtracted from net.
   * DB column is `deduction_php` (shared-prod name); surfaced internally/UI as
   * "performance shortfall". Real, subtracted deductions live in misc_items.
   */
  deduction_php: number;
  /** Off-cycle per-session/per-hour earnings (ledger snapshot); 0 by default. */
  off_cycle_php: number;
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
  // (per_hour/per_session). For FT/PT it equals gross + shortfall, so stored
  // rate_php is unchanged (parity); for per-unit it's the per-hour/session rate.
  const ratePhp = r.rate === null ? null : centavosToPhp(r.rate);
  return {
    worker_id: row.workerId,
    contract: row.contract,
    pay_basis: row.payBasis,
    units: r.units,
    expected_hours: r.expectedHours,
    worked_hours: Number(r.workedHours.toFixed(2)),
    performance_ratio: Number(r.ratio.toFixed(4)),
    rate_php: ratePhp,
    gross_php: centavosToPhp(r.gross),
    health_allowance_php: centavosToPhp(r.healthAllowance),
    thirteenth_month_php: centavosToPhp(r.thirteenth),
    pdd_lunch_php: centavosToPhp(r.pddLunch),
    bonus_php: centavosToPhp(r.bonus),
    deduction_php: centavosToPhp(r.shortfall),
    off_cycle_php: centavosToPhp(r.offCycle),
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
