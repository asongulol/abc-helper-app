/**
 * Pure Hubstaff CSV parser — no I/O, no React, fully testable.
 *
 * Mirrors the legacy parseCSV + parseHubstaff functions
 * (abc-work-app-payroll-wis-hubstaff-app/app/index.html ~4278–4362).
 *
 * Expected Hubstaff daily-report columns:
 *   Member, <date cols...>, Time off, Total worked, Activity
 * (header variants: "Member" may be at col 2 when client/project columns
 *  precede it; we find it by name rather than position).
 *
 * HH:MM:SS duration values → integer seconds.
 * Trailing totals row (no member name) is skipped.
 * Per-date seconds are summed per (name, date) to collapse multi-project rows.
 */

/** A single parsed member row from the Hubstaff report. */
export interface HubstaffMember {
  name: string;
  /** Tracked seconds keyed by ISO date string. */
  daySeconds: Record<string, number>;
  /** PTO = 0 for CSV imports (PTO source is the API). */
  ptoSeconds: Record<string, number>;
  totalSeconds: number;
  activityPct: number | null;
}

export interface HubstaffParseResult {
  /** ISO date columns found between "Member" and "Time off". */
  dates: string[];
  members: HubstaffMember[];
  skippedRows: number;
}

export interface HubstaffParseError {
  kind: 'error';
  message: string;
}

/** Convert "HH:MM:SS" / "H:MM:SS" to integer seconds; 0 for blank/zero. */
export const hmsToSeconds = (raw: string | null | undefined): number => {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s || s === '0:00:00') return 0;
  const parts = s.split(':');
  const h = Number.parseInt(parts[0] ?? '0', 10) || 0;
  const m = Number.parseInt(parts[1] ?? '0', 10) || 0;
  const sec = Number.parseInt(parts[2] ?? '0', 10) || 0;
  return h * 3600 + m * 60 + sec;
};

/**
 * Minimal RFC 4180 CSV parser (state-machine, handles double-quote escaping).
 * Returns rows as string[][], skipping fully-blank rows.
 */
export const parseRawCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let i = 0;
  let field = '';
  let row: string[] = [];
  let inQuote = false;

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        // Keep structurally-present rows (those with delimiters) even when every
        // cell is blank, so a trailing totals row stays visible to the importer's
        // skip counter; drop only truly empty lines (a single empty field).
        if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    i++;
  }
  // flush last row
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
  }
  return rows;
};

/**
 * Parse a Hubstaff daily-report CSV text into structured members + dates.
 * Returns HubstaffParseError when the file is not a valid Hubstaff report.
 */
export const parseHubstaffCsv = (text: string): HubstaffParseResult | HubstaffParseError => {
  const rows = parseRawCsv(text);
  if (rows.length === 0) {
    return { kind: 'error', message: 'Empty CSV — no rows found.' };
  }

  const firstRow = rows[0];
  if (!firstRow) return { kind: 'error', message: 'Empty CSV — no header row.' };

  const header = firstRow.map((c) => c.trim());

  // Find the "Member" column (may be at any position).
  const memberIdx = header.indexOf('Member');
  if (memberIdx < 0) {
    return {
      kind: 'error',
      message:
        'Not a Hubstaff daily report — "Member" column not found. ' +
        'Export the daily report from Hubstaff (Reports → Time & Activity → Daily).',
    };
  }

  const timeOffIdx = header.indexOf('Time off');
  const totalWorkedIdx = header.indexOf('Total worked');
  const activityIdx = header.indexOf('Activity');

  if (timeOffIdx < 0 || totalWorkedIdx < 0) {
    return {
      kind: 'error',
      message: 'Not a Hubstaff daily report — missing "Time off" or "Total worked" columns.',
    };
  }

  // Date columns sit between "Member" and "Time off".
  const dateCols = header.slice(memberIdx + 1, timeOffIdx);
  if (dateCols.length === 0) {
    return {
      kind: 'error',
      message: 'No date columns found between "Member" and "Time off".',
    };
  }

  const members: HubstaffMember[] = [];
  let skippedRows = 0;

  for (const row of rows.slice(1)) {
    const name = (row[memberIdx] ?? '').trim();
    if (!name) {
      // Totals row or blank — skip silently.
      skippedRows++;
      continue;
    }

    const daySeconds: Record<string, number> = {};
    for (let j = 0; j < dateCols.length; j++) {
      const dateLabel = dateCols[j];
      if (!dateLabel) continue;
      daySeconds[dateLabel] = hmsToSeconds(row[memberIdx + 1 + j]);
    }

    const totalSeconds = hmsToSeconds(row[totalWorkedIdx]);
    const actRaw = activityIdx >= 0 ? (row[activityIdx] ?? '').trim() : '';
    const activityPct = actRaw ? Number.parseFloat(actRaw) || null : null;

    members.push({
      name,
      daySeconds,
      ptoSeconds: {}, // CSV imports have no PTO source
      totalSeconds,
      activityPct,
    });
  }

  if (members.length === 0) {
    return {
      kind: 'error',
      message: 'No member rows found in the CSV — only the header/totals row was present.',
    };
  }

  return { dates: dateCols, members, skippedRows };
};

/** Discriminator for parse result vs error. */
export const isParseError = (
  r: HubstaffParseResult | HubstaffParseError,
): r is HubstaffParseError => 'kind' in r && r.kind === 'error';
