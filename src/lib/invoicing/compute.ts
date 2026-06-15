/**
 * Pure client-invoicing math (USD).
 *
 * A client is billed for each assigned contractor's WORKED hours × that
 * contractor's USD bill rate. Paid time off is never billed — it is the
 * employer's cost. Hours are attributed to a client via the worker→client
 * billing links (`worker_companies.bill_rate_usd`), NOT via `time_entries`
 * `company_id`: all tracked time lands on the employer, and the caller is
 * responsible for passing only that worker's employer time for the window.
 *
 * Money is integer USD `Cents` throughout (ADR-0006 — never raw floats);
 * conversion to/from `numeric(12,2)` happens at the DB/UI boundary. Worked hours
 * are rounded to 2dp (matching `invoice_lines.worked_hours numeric(10,2)`) before
 * multiplying, so a persisted line reproduces its amount exactly.
 */
import {
  type Cents,
  cents,
  majorToMinor,
  mulRatioMinor,
  roundHalfAwayFromZero,
  sumMinor,
} from '@/lib/money';

export interface RosterEntry {
  workerId: string;
  workerName: string;
  position: string | null;
  /** `worker_companies.bill_rate_usd` in major USD (dollars). null/0 ⇒ a $0 line. */
  billRateUsd: number | null;
}

export interface WorkerSeconds {
  workerId: string;
  /** Tracked seconds for this worker in the window (PTO already excluded). */
  trackedSeconds: number;
}

export interface InvoiceLine {
  workerId: string;
  workerName: string;
  position: string | null;
  /** Worked hours, rounded to 2dp. */
  workedHours: number;
  /** Bill rate in major USD, rounded to 2dp. */
  billRateUsd: number;
  /** Line amount in integer USD cents (= billRate × workedHours). */
  amount: Cents;
}

export interface InvoiceComputation {
  lines: InvoiceLine[];
  subtotal: Cents;
  /** subtotal × (1 + markupPct/100). */
  total: Cents;
  /** Σ workedHours, 2dp. */
  totalHours: number;
  markupPct: number;
}

/** Round to 2 decimal places, half away from zero (for hours / major-unit rates). */
const round2 = (n: number): number => roundHalfAwayFromZero(n * 100) / 100;

const dollarsToCents = (dollars: number): Cents => cents(majorToMinor(round2(dollars)));

/**
 * Compute an invoice preview from a client's roster and that roster's tracked time.
 * Lines with zero worked hours are dropped; zero-rate lines are kept (billed $0)
 * so the caller can flag a missing bill rate. Lines are sorted by contractor name.
 */
export function computeInvoice(
  roster: readonly RosterEntry[],
  time: readonly WorkerSeconds[],
  markupPct: number,
): InvoiceComputation {
  const secByWorker = new Map<string, number>();
  for (const t of time) {
    if (!t.workerId) continue;
    secByWorker.set(
      t.workerId,
      (secByWorker.get(t.workerId) ?? 0) + (Number(t.trackedSeconds) || 0),
    );
  }

  const lines: InvoiceLine[] = roster
    .filter((r) => Boolean(r.workerId))
    .map((r) => {
      const workedHours = round2((secByWorker.get(r.workerId) ?? 0) / 3600);
      const billRateUsd = round2(Number(r.billRateUsd) || 0);
      return {
        workerId: r.workerId,
        workerName: r.workerName,
        position: r.position,
        workedHours,
        billRateUsd,
        amount: mulRatioMinor(dollarsToCents(billRateUsd), workedHours),
      };
    })
    .filter((l) => l.workedHours > 0)
    .sort((a, b) => a.workerName.localeCompare(b.workerName));

  const subtotal = sumMinor(lines.map((l) => l.amount));
  const markup = Number.isFinite(markupPct) && markupPct > 0 ? markupPct : 0;
  const total = markup > 0 ? mulRatioMinor(subtotal, 1 + markup / 100) : subtotal;
  const totalHours = round2(lines.reduce((sum, l) => sum + l.workedHours, 0));

  return { lines, subtotal, total, totalHours, markupPct: markup };
}
