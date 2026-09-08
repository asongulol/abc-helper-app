/**
 * PTO accrual, reference only (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decision 7):
 * a full-time year (2,080 h) earns 12 days, capped at the contract's days per
 * year; a day used is 8 h of PTO from the Hubstaff sync; the balance carries
 * over year to year up to a 30-day ceiling. Part-timers use the same formula
 * and simply reach less. Calculate never reads this.
 */

export const FULL_TIME_HOURS = 2080;
export const HOURS_PER_DAY = 8;
export const ACCRUAL_DAYS = 12;
export const BALANCE_CEILING_DAYS = 30;

export type PtoYearInput = {
  year: number;
  /** Approved tracked seconds, PTO excluded. */
  trackedSeconds: number;
  /** Approved PTO seconds. */
  ptoSeconds: number;
};

export type PtoYearBalance = {
  year: number;
  trackedHours: number;
  accruedDays: number;
  usedDays: number;
  /** Balance brought in from the year before (0 for the first year). */
  carriedInDays: number;
  /** carriedIn + accrued − used, capped at the ceiling; may go negative. */
  balanceDays: number;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Oldest year first; each year's balance is the next year's carry-in. */
export const ptoAccrual = (years: readonly PtoYearInput[], capDays: number): PtoYearBalance[] => {
  const out: PtoYearBalance[] = [];
  let carry = 0;
  for (const y of [...years].sort((a, b) => a.year - b.year)) {
    const trackedHours = y.trackedSeconds / 3600;
    const accruedDays = Math.min(capDays, (ACCRUAL_DAYS * trackedHours) / FULL_TIME_HOURS);
    const usedDays = y.ptoSeconds / 3600 / HOURS_PER_DAY;
    const balanceDays = Math.min(BALANCE_CEILING_DAYS, carry + accruedDays - usedDays);
    out.push({
      year: y.year,
      trackedHours: round2(trackedHours),
      accruedDays: round2(accruedDays),
      usedDays: round2(usedDays),
      carriedInDays: round2(carry),
      balanceDays: round2(balanceDays),
    });
    carry = balanceDays;
  }
  return out;
};
