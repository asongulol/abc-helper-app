/**
 * Pure client-invoicing math (USD).
 *
 * A client is billed two ways, which may both appear on one invoice:
 *   - HOURLY: each assigned contractor's WORKED hours × that contractor's USD
 *     hourly bill rate (`worker_companies.bill_rate_usd`). Paid time off is never
 *     billed — it is the employer's cost. All tracked time lands on the employer,
 *     and the caller passes only that worker's employer time for the window.
 *   - SESSION: a flat fee per approved session/visit — `sessions × session rate`
 *     (`worker_companies.session_rate_usd`) — duration is ignored. Sessions are
 *     recorded against the client directly; the caller passes only APPROVED
 *     counts for the window.
 *
 * Markup (`invoices.markup_pct`) applies ONCE to the combined subtotal, never
 * per kind.
 *
 * Money is integer USD `Cents` throughout (ADR-0006 — never raw floats);
 * conversion to/from `numeric(12,2)` happens at the DB/UI boundary. Worked hours
 * are rounded to 2dp (matching `invoice_lines.worked_hours numeric(10,2)`) before
 * multiplying, so a persisted line reproduces its amount exactly. Session counts
 * are whole units, so `rate_cents × count` is already exact.
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

/**
 * A worker's approved sessions for the window. Self-contained (carries its own
 * name/position/rate) so session billing does NOT depend on the active roster —
 * an approved session still bills after the worker's client link is deactivated
 * or ended (the rate is resolved from that link regardless of its status).
 */
export interface WorkerSessions {
  workerId: string;
  workerName: string;
  position: string | null;
  /** Σ approved session units for this worker in the window (caller pre-filters). */
  sessionsCount: number;
  /** `worker_companies.session_rate_usd` in major USD. null/0 ⇒ a $0 session line. */
  sessionRateUsd: number | null;
}

/** Hourly vs. flat-fee-per-session line. Irrelevant fields are 0 for each kind. */
export type LineKind = 'hourly' | 'session';

export interface InvoiceLine {
  workerId: string;
  workerName: string;
  position: string | null;
  kind: LineKind;
  /** Worked hours, rounded to 2dp (0 for session lines). */
  workedHours: number;
  /** Hourly bill rate in major USD, rounded to 2dp (0 for session lines). */
  billRateUsd: number;
  /** Approved session count (0 for hourly lines). */
  sessionsCount: number;
  /** Session rate in major USD, rounded to 2dp (0 for hourly lines). */
  sessionRateUsd: number;
  /** Line amount in integer USD cents. */
  amount: Cents;
}

export interface InvoiceComputation {
  lines: InvoiceLine[];
  subtotal: Cents;
  /** subtotal × (1 + markupPct/100). */
  total: Cents;
  /** Σ workedHours, 2dp. */
  totalHours: number;
  /** Σ session counts. */
  totalSessions: number;
  markupPct: number;
}

/** Round to 2 decimal places, half away from zero (for hours / major-unit rates). */
const round2 = (n: number): number => roundHalfAwayFromZero(n * 100) / 100;

const dollarsToCents = (dollars: number): Cents => cents(majorToMinor(round2(dollars)));

/**
 * Compute an invoice preview from a client's active roster (for hourly time),
 * that roster's tracked time, and that client's approved sessions. HOURLY lines
 * are roster-driven (tracked time is employer-scoped and attributed via the
 * active link); SESSION lines are driven by the session data itself (each
 * session carries its own rate), so an approved session bills even if the
 * worker's link is now inactive/ended. A worker may produce an hourly line AND a
 * session line. Lines with zero quantity (hours / sessions) are dropped;
 * zero-rate lines are kept (billed $0) so the caller can flag a missing rate.
 * Lines are sorted by contractor name and markup is applied once to the combined
 * subtotal.
 */
export function computeInvoice(
  roster: readonly RosterEntry[],
  time: readonly WorkerSeconds[],
  sessions: readonly WorkerSessions[],
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

  // Aggregate sessions per worker (sum units; keep name/position/rate). Driven by
  // the session data, NOT the roster, so deactivated-link sessions still bill.
  const sessionByWorker = new Map<
    string,
    { workerName: string; position: string | null; sessionRateUsd: number | null; count: number }
  >();
  for (const s of sessions) {
    if (!s.workerId) continue;
    const cur = sessionByWorker.get(s.workerId);
    if (cur) cur.count += Number(s.sessionsCount) || 0;
    else
      sessionByWorker.set(s.workerId, {
        workerName: s.workerName,
        position: s.position,
        sessionRateUsd: s.sessionRateUsd,
        count: Number(s.sessionsCount) || 0,
      });
  }

  const hourlyLines: InvoiceLine[] = roster
    .filter((r) => Boolean(r.workerId))
    .map((r) => {
      const workedHours = round2((secByWorker.get(r.workerId) ?? 0) / 3600);
      const billRateUsd = round2(Number(r.billRateUsd) || 0);
      return {
        workerId: r.workerId,
        workerName: r.workerName,
        position: r.position,
        kind: 'hourly' as const,
        workedHours,
        billRateUsd,
        sessionsCount: 0,
        sessionRateUsd: 0,
        amount: mulRatioMinor(dollarsToCents(billRateUsd), workedHours),
      };
    })
    .filter((l) => l.workedHours > 0);

  const sessionLines: InvoiceLine[] = [...sessionByWorker.entries()]
    .map(([workerId, v]) => {
      const sessionRateUsd = round2(Number(v.sessionRateUsd) || 0);
      return {
        workerId,
        workerName: v.workerName,
        position: v.position,
        kind: 'session' as const,
        workedHours: 0,
        billRateUsd: 0,
        sessionsCount: v.count,
        sessionRateUsd,
        amount: mulRatioMinor(dollarsToCents(sessionRateUsd), v.count),
      };
    })
    .filter((l) => l.sessionsCount > 0);

  const lines = [...hourlyLines, ...sessionLines].sort((a, b) =>
    a.workerName.localeCompare(b.workerName),
  );

  const subtotal = sumMinor(lines.map((l) => l.amount));
  const markup = Number.isFinite(markupPct) && markupPct > 0 ? markupPct : 0;
  const total = markup > 0 ? mulRatioMinor(subtotal, 1 + markup / 100) : subtotal;
  const totalHours = round2(hourlyLines.reduce((sum, l) => sum + l.workedHours, 0));
  const totalSessions = sessionLines.reduce((sum, l) => sum + l.sessionsCount, 0);

  return { lines, subtotal, total, totalHours, totalSessions, markupPct: markup };
}
