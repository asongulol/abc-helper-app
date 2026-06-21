import { describe, expect, it } from 'vitest';
import { parseSessionCsv } from '@/lib/sessions/import-csv';

const roster = new Map([
  ['jane dela cruz', 'w-jane'],
  ['mark reyes', 'w-mark'],
]);

describe('parseSessionCsv', () => {
  it('parses a well-formed CSV and resolves names', () => {
    const csv = [
      'contractor,date,units,type,child,eiid,case,notes',
      'Jane Dela Cruz,2026-06-20,2,IFSP Meeting,JD,EI-1,C-9,hello',
      'Mark Reyes,2026-06-21,,Amendment Meeting,,,,',
    ].join('\n');
    const { rows, errors } = parseSessionCsv(csv, roster);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workerId: 'w-jane',
      sessionDate: '2026-06-20',
      units: 2,
      sessionType: 'IFSP Meeting',
      childInitials: 'JD',
      eiid: 'EI-1',
      caseRef: 'C-9',
      notes: 'hello',
    });
    // blank units default to 1; blank optionals → null
    expect(rows[1]).toMatchObject({
      workerId: 'w-mark',
      units: 1,
      childInitials: null,
      caseRef: null,
    });
  });

  it('is case-insensitive on names and tolerant of header aliases', () => {
    const csv = ['name,session_date,qty', 'JANE DELA CRUZ,2026-06-20,3'].join('\n');
    const { rows, errors } = parseSessionCsv(csv, roster);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ workerId: 'w-jane', units: 3 });
  });

  it('collects per-line errors without throwing', () => {
    const csv = [
      'contractor,date,units',
      'Unknown Person,2026-06-20,1',
      'Jane Dela Cruz,06/20/2026,1',
      'Mark Reyes,2026-06-21,0',
      'Mark Reyes,2026-06-22,2',
    ].join('\n');
    const { rows, errors } = parseSessionCsv(csv, roster);
    expect(rows).toHaveLength(1); // only the last valid row
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('not on this client');
    expect(errors[1]).toContain('YYYY-MM-DD');
    expect(errors[2]).toContain('whole number');
  });

  it('rejects a CSV missing required columns or rows', () => {
    expect(parseSessionCsv('contractor,units\nJane,2', roster).errors[0]).toContain('date');
    expect(parseSessionCsv('contractor,date', roster).errors[0]).toContain('at least one data row');
  });
});
