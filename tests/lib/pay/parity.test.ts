/**
 * PARITY ORACLE — the new money core vs real historical payouts.
 *
 * Fixture: tests/fixtures/parity-rows.json — 117 payment rows sampled READ-ONLY
 * from PAID periods of the live ABC database (2024-02 → 2026-05): health-allowance
 * hits, 13th-month accruals, misc items, prorated rows, manual overrides, both
 * FT and PT contracts.
 *
 * What the live data taught us (every exclusion below is asserted, not assumed):
 *  1. `original_net_php` — the Wise backfill matcher can overwrite `net_php`
 *     with the actually-transferred amount; the formula-era net is preserved in
 *     `original_net_php`. Parity is checked against the formula-era value.
 *  2. 2025-11-16..30 — the 13th-month payout batch: `t13`/`net` were set
 *     manually out-of-band. Excluded, and asserted to be the ONLY t13 rows.
 *  3. Post-hoc annotations — some rows have net == gross exactly while ha/pdd
 *     columns are non-zero: the allowance was paid separately and recorded on
 *     the row AFTER lock. Detected by that exact pattern and counted.
 *  4. 2026-04-16..30 — a mid-April rate restructure left ~10 rows whose gross
 *     reflects rates different from the stored snapshot. Excluded as a period;
 *     asserted that NO other period shows this.
 *
 * Tolerances derive from legacy storage rounding: `worked_hours` was stored at
 * 2 dp while gross used the unrounded value → gross recomputed from stored
 * inputs may drift by rate × (0.005 / expected_hours). Everything else: ±1
 * centavo (`toFixed(2)` noise).
 */

import { centavos, majorToMinor, mulRatioMinor } from '@/lib/money';
import { type MiscItem, RATIO_CAP, miscTotal } from '@/lib/pay/calc';
import { expectedHours } from '@/lib/pay/expected-hours';
import { describe, expect, it } from 'vitest';
import rowsJson from '../../fixtures/parity-rows.json';

type FixtureRow = {
  period_start: string;
  period_end: string;
  worker_id: string;
  expected_hours: number | null;
  worked_hours: number;
  performance_ratio: number;
  rate_php: number;
  gross_php: number;
  ha_php: number;
  t13_php: number;
  pdd_php: number;
  bonus_php: number;
  ded_php: number;
  net_php: number;
  original_net_php: number | null;
  status: string;
  misc_items: MiscItem[] | null;
  overridden: boolean;
  contract: string | null;
  hire_date: string | null;
  ha_elig: boolean;
  t13_elig: boolean;
};

const rows = rowsJson as FixtureRow[];
const c = (php: number) => majorToMinor(php);
const label = (r: FixtureRow) => `${r.worker_id.slice(-6)} ${r.period_start}..${r.period_end}`;

/** The manually-handled 13th-month payout batch. */
const THIRTEENTH_PAYOUT_PERIOD = '2025-11-16';
/** Mid-April 2026 rate restructure — gross snapshots don't match stored rates. */
const RATE_RESTRUCTURE_PERIOD = '2026-04-16';

/** Formula-era net: the value the calc engine produced at lock time. */
const effectiveNet = (r: FixtureRow): number =>
  c(r.original_net_php != null ? r.original_net_php : r.net_php);

const extras = (r: FixtureRow): number =>
  c(r.ha_php) + c(r.t13_php) + c(r.pdd_php) + c(r.bonus_php) + miscTotal(r.misc_items);

describe('parity vs real paid periods (read-only fixture)', () => {
  it('has a meaningful sample', () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => r.ha_php > 0).length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => +r.performance_ratio < 0.999).length).toBeGreaterThan(50);
    expect(new Set(rows.map((r) => r.period_start)).size).toBeGreaterThanOrEqual(10);
  });

  it('net = gross + extras on every row, except post-hoc annotations (which must match the annotation pattern)', () => {
    const annotations: string[] = [];
    for (const r of rows) {
      if (r.period_start === THIRTEENTH_PAYOUT_PERIOD) continue;
      const recombined = c(r.gross_php) + extras(r);
      const net = effectiveNet(r);
      if (Math.abs(recombined - net) <= 1) continue;
      // Post-hoc annotation: allowance paid separately and recorded after lock —
      // net stayed exactly at gross while extras columns are non-zero.
      const isAnnotation = net === c(r.gross_php) && extras(r) !== 0;
      expect(isAnnotation, `${label(r)} net≠formula and not an annotation`).toBe(true);
      annotations.push(label(r));
    }
    // Locked count: if this moves, a NEW kind of divergence appeared — investigate.
    expect(annotations).toHaveLength(12);
  });

  it('gross reproduces from stored worked/expected on non-overridden rows (all periods except the April-2026 restructure)', () => {
    const offPeriodFailures: string[] = [];
    let checked = 0;
    for (const r of rows) {
      if (r.overridden || r.expected_hours == null || r.expected_hours <= 0) continue;
      if (r.period_start === THIRTEENTH_PAYOUT_PERIOD) continue;
      const exp = Number(r.expected_hours);
      const ratio = Math.min(r.worked_hours / exp, RATIO_CAP);
      const rate = centavos(c(r.rate_php));
      const gross = ratio >= 1 ? rate : mulRatioMinor(rate, ratio);
      // worked_hours stored at 2 dp; legacy gross used the unrounded value.
      const tolerance = Math.max(1, Math.ceil(rate * (0.005 / exp))) + 1;
      const ok = Math.abs(gross - c(r.gross_php)) <= tolerance;
      if (r.period_start === RATE_RESTRUCTURE_PERIOD) continue; // excluded — see header
      checked++;
      if (!ok) offPeriodFailures.push(label(r));
    }
    // 61 of the 117 fixture rows predate the app storing expected_hours.
    expect(checked).toBeGreaterThan(30);
    expect(offPeriodFailures, offPeriodFailures.join('\n')).toEqual([]);
  });

  it('the April-2026 restructure is the ONLY period with unexplained gross', () => {
    const anomalies = rows.filter((r) => {
      if (r.overridden || r.expected_hours == null || r.expected_hours <= 0) return false;
      if (r.period_start === THIRTEENTH_PAYOUT_PERIOD) return false;
      const exp = Number(r.expected_hours);
      const ratio = Math.min(r.worked_hours / exp, RATIO_CAP);
      const rate = centavos(c(r.rate_php));
      const gross = ratio >= 1 ? rate : mulRatioMinor(rate, ratio);
      const tolerance = Math.max(1, Math.ceil(rate * (0.005 / exp))) + 1;
      return Math.abs(gross - c(r.gross_php)) > tolerance;
    });
    expect(new Set(anomalies.map((r) => r.period_start))).toEqual(
      new Set([RATE_RESTRUCTURE_PERIOD]),
    );
    expect(anomalies).toHaveLength(10);
  });

  it('stored performance_ratio matches worked/expected (4 dp snapshot)', () => {
    for (const r of rows) {
      if (r.overridden || r.expected_hours == null || r.expected_hours <= 0) continue;
      const ratio = Math.min(r.worked_hours / Number(r.expected_hours), RATIO_CAP);
      expect(Math.abs(ratio - r.performance_ratio), label(r)).toBeLessThanOrEqual(0.005);
    }
  });

  it('expected-hours engine reproduces stored expected_hours (FT or PT — the join sees the CURRENT contract, which may have changed since)', () => {
    const candidates = rows.filter((r) => r.expected_hours != null && Number(r.expected_hours) > 0);
    expect(candidates.length).toBeGreaterThan(40);
    const mismatches: string[] = [];
    for (const r of candidates) {
      const ft = expectedHours('FT', r.period_start, r.period_end);
      const pt = expectedHours('PT', r.period_start, r.period_end);
      if (Number(r.expected_hours) !== ft && Number(r.expected_hours) !== pt) {
        mismatches.push(`${label(r)} stored=${r.expected_hours} engineFT=${ft} enginePT=${pt}`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('all 13th-month rows in the sample belong to the manual payout batch (formula parity for t13 is covered by unit tests)', () => {
    const t13Rows = rows.filter((r) => r.t13_php > 0);
    expect(t13Rows.length).toBeGreaterThan(5);
    expect(new Set(t13Rows.map((r) => r.period_start))).toEqual(
      new Set([THIRTEENTH_PAYOUT_PERIOD]),
    );
  });
});
