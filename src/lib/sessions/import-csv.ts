/**
 * Pure CSV parser for the admin "import sessions" flow (no I/O, testable).
 *
 * Resolves each row's contractor name against the client's roster (name → workerId)
 * and validates the shape, collecting human-readable per-line errors rather than
 * throwing — so the modal can show a preview of what will / won't import.
 *
 * Recognized headers (case-insensitive; order-independent):
 *   contractor|name (req) · date (req, YYYY-MM-DD) · units (default 1) ·
 *   type|session_type · child|child_initials · eiid · case|case_ref · notes
 */

export interface ParsedSessionRow {
  workerId: string;
  sessionDate: string;
  sessionType: string | null;
  units: number;
  childInitials: string | null;
  eiid: string | null;
  caseRef: string | null;
  notes: string | null;
}

export interface SessionCsvResult {
  rows: ParsedSessionRow[];
  errors: string[];
}

const HEADER_ALIASES: Record<string, string> = {
  contractor: 'name',
  name: 'name',
  worker: 'name',
  date: 'date',
  session_date: 'date',
  units: 'units',
  qty: 'units',
  type: 'type',
  session_type: 'type',
  item: 'type',
  child: 'child',
  child_initials: 'child',
  eiid: 'eiid',
  case: 'case',
  case_ref: 'case',
  notes: 'notes',
};

const clean = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

export const parseSessionCsv = (
  text: string,
  rosterByName: Map<string, string>,
): SessionCsvResult => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) {
    return { rows: [], errors: ['Need a header row and at least one data row.'] };
  }

  const delim = (lines[0] as string).includes('\t') ? '\t' : ',';
  const split = (l: string) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));

  const header = split(lines[0] as string).map(
    (h) => HEADER_ALIASES[h.toLowerCase()] ?? h.toLowerCase(),
  );
  const col = (name: string) => header.indexOf(name);
  if (col('name') < 0 || col('date') < 0) {
    return { rows: [], errors: ['CSV must have a "contractor" (or "name") and a "date" column.'] };
  }

  const rows: ParsedSessionRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = split(lines[i] as string);
    const at = (name: string): string | undefined => {
      const idx = col(name);
      return idx >= 0 ? cells[idx] : undefined;
    };
    const lineNo = i + 1;

    const name = clean(at('name'));
    if (!name) {
      errors.push(`Line ${lineNo}: missing contractor name.`);
      continue;
    }
    const workerId = rosterByName.get(name.toLowerCase());
    if (!workerId) {
      errors.push(`Line ${lineNo}: "${name}" is not on this client's active roster.`);
      continue;
    }

    const date = clean(at('date')) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Line ${lineNo}: date "${date}" must be YYYY-MM-DD.`);
      continue;
    }

    const unitsRaw = clean(at('units'));
    const units = unitsRaw === null ? 1 : Number(unitsRaw);
    if (!Number.isInteger(units) || units < 1) {
      errors.push(`Line ${lineNo}: units "${unitsRaw}" must be a whole number ≥ 1.`);
      continue;
    }

    rows.push({
      workerId,
      sessionDate: date,
      units,
      sessionType: clean(at('type')),
      childInitials: clean(at('child')),
      eiid: clean(at('eiid')),
      caseRef: clean(at('case')),
      notes: clean(at('notes')),
    });
  }

  return { rows, errors };
};
