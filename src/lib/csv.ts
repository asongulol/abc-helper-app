/**
 * The one CSV field escape, shared by every builder in the app (RP-62).
 *
 * It lived in `lib/payroll/bank-export.ts` — the module that happened to need it
 * first — so the Wise, individual-payments, reports and invoicing builders all
 * imported a bank-export symbol to escape their own files, and a fifth builder
 * (the audit-log export) quietly grew its own copy without the injection guard.
 * One home, no builder-specific ownership.
 *
 * Pure, no DB access. Beyond RFC 4180 quoting it neutralizes spreadsheet formula
 * injection: admins open these files in Excel/Sheets, where a cell starting with
 * = + - @ (or TAB / CR) is EXECUTED. A leading `'` keeps it text.
 */

/** A value Excel reads back as a number — never prefix these (e.g. a -500 amount). */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Escape one already-stringified cell. */
export const escapeCsvField = (v: string): string => {
  const s = /^[=+@\t\r-]/.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Null/number-tolerant wrapper — for builders that map over mixed cells. */
export const csvEscape = (v: string | number | null | undefined): string =>
  escapeCsvField(v == null ? '' : String(v));
