/**
 * What a Wise transfer's `details.reference` says about which period it paid.
 *
 * Every transfer carries one, and it is the only field that states intent
 * directly — amount, date and recipient can all coincide across periods. Seen in
 * production across 2023–2026:
 *
 *   "Payroll 2026-07-15"          the period it pays, by its END date
 *   "20240712"                    the batch's send date (that period's deadline)
 *   "20231215 and 13th Pt 2"      a period plus something else
 *   "Health Allowance 2024"       not payroll at all — never matches a payroll row
 *   "Loan - 20240514", "Lunch"    likewise
 *   "20240130 corrects overpayment"  the operator's own note
 *
 * It is free text, often empty (71 of 265 unclaimed transfers had none), and
 * sometimes just "Payroll" — so it is a SIGNAL, never a key. Unknown is a real
 * answer here, and it is spelled `null`.
 */

const DAY_MS = 86_400_000;

/** Dates a reference can carry: 2026-07-15 or 20260715. Bare years are ignored —
 *  "Health Allowance 2024" names a benefit, not a period. */
const DATE_PATTERNS = [/\b(\d{4})-(\d{2})-(\d{2})\b/g, /\b(\d{4})(\d{2})(\d{2})\b/g];

/** Every date mentioned in a reference, as UTC midnight ms. */
export const referenceDates = (reference: string | null | undefined): number[] => {
  if (!reference) return [];
  const out: number[] = [];
  for (const re of DATE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of reference.matchAll(re)) {
      const [, y, mo, d] = m;
      const ms = Date.parse(`${y}-${mo}-${d}T00:00:00.000Z`);
      // Date.parse rejects 2026-13-40; a real payroll reference never predates
      // the business, so anything before 2000 is a coincidence (an account
      // number, an invoice id) rather than a date.
      if (!Number.isNaN(ms) && ms > Date.UTC(2000, 0, 1)) out.push(ms);
    }
  }
  return out;
};

export interface PeriodWindow {
  periodStart?: string | null;
  periodEnd?: string | null;
  payDate?: string | null;
}

/**
 * Does this reference name the period the row belongs to?
 *
 *   true   — it names a date this period owns (its end, or a day in its
 *            [start, deadline] span). Confirms the match.
 *   false  — it names a date that belongs to a DIFFERENT period. This is the
 *            duplicate guard: a transfer sent inside this period's window whose
 *            reference names the last one is the previous batch's, and linking it
 *            would mark a period paid that nobody paid.
 *   null   — no opinion: no reference, or no date in it ("Payroll", "Lunch",
 *            "Health Allowance 2024"). Most transfers land here, which is why
 *            this can only ever be one input among several.
 */
export const referenceMatchesPeriod = (
  reference: string | null | undefined,
  window: PeriodWindow,
): boolean | null => {
  const dates = referenceDates(reference);
  if (dates.length === 0) return null;

  const end = window.periodEnd ? Date.parse(`${window.periodEnd}T00:00:00.000Z`) : Number.NaN;
  const start = window.periodStart ? Date.parse(`${window.periodStart}T00:00:00.000Z`) : Number.NaN;
  const due = window.payDate ? Date.parse(`${window.payDate}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(end) && Number.isNaN(start) && Number.isNaN(due)) return null;

  const lo = Number.isNaN(start) ? end : start;
  // The deadline plus the fortnight of slack a manual run can drift by — the
  // same tolerance the link path uses before it demands a written reason.
  const hi = (Number.isNaN(due) ? end : Math.max(due, end)) + 14 * DAY_MS;

  return dates.some((d) => d === end || (d >= lo && d <= hi));
};
