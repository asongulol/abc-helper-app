/**
 * Pure CSV builders for the Reports screen.
 * All monetary values accepted in centavos; output in PHP major units (2 dp).
 */

import type { ReportPaymentRow, ReportPeriodRow } from '@/db/queries/reports';
import { centavosToPhp } from '@/lib/format';

const esc = (v: string | number | null | undefined): string => {
  const s = v == null ? '' : String(v);
  // Wrap in quotes if it contains a comma, double-quote, or newline
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const row = (cells: (string | number | null | undefined)[]): string => cells.map(esc).join(',');

const phpFmt = (centavos: number): string => centavosToPhp(centavos).toFixed(2);

/**
 * Build a period-summary CSV from the Reports screen data.
 * Mirrors the legacy Reports tab "Export" cut.
 */
export const buildPeriodSummaryCsv = (periods: readonly ReportPeriodRow[]): string => {
  const header = row([
    'Period Start',
    'Period End',
    'Pay Date',
    'State',
    'Contractors',
    'Gross PHP',
    'Health Allowance PHP',
    '13th Month PHP',
    'Net PHP',
  ]);
  const rows = periods.map((p) =>
    row([
      p.periodStart,
      p.periodEnd,
      p.payDate ?? '',
      p.state,
      p.contractorCount,
      phpFmt(p.totalGrossCentavos),
      phpFmt(p.totalHaCentavos),
      phpFmt(p.totalT13Centavos),
      phpFmt(p.totalNetCentavos),
    ]),
  );
  return [header, ...rows].join('\n');
};

/**
 * Build a per-payment detailed CSV (one row per contractor per period).
 */
export const buildPaymentDetailCsv = (payments: readonly ReportPaymentRow[]): string => {
  const header = row([
    'Period Start',
    'Period End',
    'Worker',
    'Gross PHP',
    'Health Allowance PHP',
    '13th Month PHP',
    'PDD/Lunch PHP',
    'Bonus PHP',
    'Shortfall PHP',
    'Net PHP',
    'Payout Method',
    'Status',
  ]);
  const rows = payments.map((p) =>
    row([
      p.periodStart,
      p.periodEnd,
      p.workerName,
      phpFmt(p.grossCentavos),
      phpFmt(p.haCentavos),
      phpFmt(p.t13Centavos),
      phpFmt(p.pddCentavos),
      phpFmt(p.bonusCentavos),
      phpFmt(p.shortfallCentavos),
      phpFmt(p.netCentavos),
      p.payoutMethod ?? '',
      p.status,
    ]),
  );
  return [header, ...rows].join('\n');
};

/** Trigger a browser download with the given CSV content. */
export const downloadCsv = (filename: string, csvContent: string): void => {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
