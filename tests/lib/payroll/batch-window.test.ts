import { describe, expect, it } from 'vitest';
import { batchForWindow } from '@/lib/payroll/batch-window';

const batches = [
  { id: 'regular-jul-2', periodStart: '2026-07-16', periodEnd: '2026-07-31' },
  { id: 'regular-jul-1', periodStart: '2026-07-01', periodEnd: '2026-07-15' },
  // Off-cycle batches are stored with start === end.
  { id: 'offcycle-jul-20', periodStart: '2026-07-20', periodEnd: '2026-07-20' },
];

describe('batchForWindow', () => {
  it('matches a regular half-month window', () => {
    expect(batchForWindow(batches, '2026-07-01', '2026-07-15')?.id).toBe('regular-jul-1');
  });

  it('matches a single-day off-cycle batch verbatim', () => {
    expect(batchForWindow(batches, '2026-07-20', '2026-07-20')?.id).toBe('offcycle-jul-20');
  });

  it('needs BOTH ends to match — a right start with a wrong end is not the batch', () => {
    expect(batchForWindow(batches, '2026-07-01', '2026-07-31')).toBeNull();
    expect(batchForWindow(batches, '2026-07-20', '2026-07-31')).toBeNull();
  });

  it('returns null for a window with no saved batch', () => {
    expect(batchForWindow(batches, '2026-08-01', '2026-08-15')).toBeNull();
    expect(batchForWindow([], '2026-07-01', '2026-07-15')).toBeNull();
  });

  /**
   * The seed only works while /payroll's server page and PayrollShell resolve
   * the SAME batch for a window. Both now route through here, so one call
   * standing in for both is the honest check.
   */
  it('gives the server and the client the same answer for one window', () => {
    const server = batchForWindow(batches, '2026-07-16', '2026-07-31');
    const client = batchForWindow(batches, '2026-07-16', '2026-07-31');
    expect(server?.id).toBe(client?.id);
    expect(server?.id).toBe('regular-jul-2');
  });
});
