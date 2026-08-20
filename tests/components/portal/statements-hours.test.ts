import { describe, expect, it } from 'vitest';
import { bucketHours } from '@/components/portal/PortalStatements';

const entry = (workDate: string, trackedSeconds: number, ptoSeconds = 0) => ({
  id: workDate,
  workDate,
  trackedSeconds,
  ptoSeconds,
  activityPct: null,
  approval: 'approved' as const,
});

describe('bucketHours — time entries → per-period totals and day rows', () => {
  it('buckets by semi-monthly period, converts to hours, sorts days ascending', () => {
    const map = bucketHours([
      entry('2026-08-14', 4 * 3600),
      entry('2026-08-03', 8 * 3600),
      entry('2026-08-16', 6 * 3600), // next period (16–EOM)
    ]);
    const first = map.get('2026-08-01');
    expect(first?.worked).toBeCloseTo(12, 5);
    expect(first?.days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-14']);
    expect(map.get('2026-08-16')?.worked).toBeCloseTo(6, 5);
  });

  it('sums PTO separately and merges same-day entries', () => {
    const map = bucketHours([entry('2026-08-05', 2 * 3600, 3600), entry('2026-08-05', 3600, 0)]);
    const b = map.get('2026-08-01');
    expect(b?.worked).toBeCloseTo(3, 5);
    expect(b?.pto).toBeCloseTo(1, 5);
    expect(b?.days).toHaveLength(1);
    expect(b?.days[0].tracked).toBeCloseTo(3, 5);
    expect(b?.days[0].pto).toBeCloseTo(1, 5);
  });
});
