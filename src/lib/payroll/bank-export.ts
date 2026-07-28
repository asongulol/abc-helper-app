/**
 * BPI/bank CSV export builder — pure, no DB access.
 *
 * Generates a CSV suitable for BPI or generic bank batch upload with:
 *   Name, Bank (placeholder), Account (placeholder), Amount PHP (2 dp)
 *
 * Uses centavos as the input unit and formats to PHP major units (2 dp)
 * exactly as stored — no float accumulation.
 */

export type BankExportRow = {
  name: string;
  /** PHP major units (from the DB). */
  netPhp: number;
  payoutMethod: string | null;
};

/** A value Excel reads back as a number — never prefix these (e.g. a -500 amount). */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Shared CSV field escape for all three payroll builders (RP-62).
 *
 * Beyond RFC 4180 quoting, it neutralizes spreadsheet formula injection: admins
 * open these files in Excel/Sheets, where a cell starting with = + - @ (or TAB /
 * CR) is EXECUTED. A leading `'` keeps it text. Plain numbers are exempt so the
 * amount columns stay machine-readable.
 */
export const escapeCsvField = (v: string): string => {
  const s = /^[=+@\t\r-]/.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Build a BPI/bank CSV for the given payment rows.
 * Filters to non-wise rows (or all rows when `all=true`).
 * Returns the CSV string and filename.
 */
export const buildBankExport = (
  rows: readonly BankExportRow[],
  opts: { periodStart: string; periodEnd: string; includeWise?: boolean },
): { csv: string; filename: string } => {
  const exportRows = opts.includeWise ? rows : rows.filter((r) => r.payoutMethod !== 'wise');

  const header = ['Name', 'Bank', 'Account', 'Amount (PHP)'].join(',');
  const lines = exportRows.map((r) => {
    const amountPhp = r.netPhp.toFixed(2);
    return [
      escapeCsvField(r.name),
      escapeCsvField(r.payoutMethod ?? ''),
      '', // account placeholder — not stored in this system
      amountPhp,
    ].join(',');
  });

  const csv = [header, ...lines].join('\n');
  const filename = `payroll-${opts.periodStart}-to-${opts.periodEnd}.csv`;
  return { csv, filename };
};

/**
 * Trigger a browser download of the CSV string.
 * Call from a client component only.
 */
export const downloadCsv = (csv: string, filename: string): void => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
