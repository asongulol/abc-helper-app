import { describe, expect, it } from 'vitest';
import { classifyCoverage } from '@/lib/coverage/classify';

const exp = (workerId: string, expectedHours: number, workerName = workerId) => ({
  workerId,
  workerName,
  expectedHours,
});

describe('classifyCoverage', () => {
  it('flags an expected-but-zero contractor as zero_time', () => {
    const gaps = classifyCoverage([exp('w1', 40)], []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ workerId: 'w1', kind: 'zero_time', ratio: 0 });
  });

  it('flags under-coverage below the threshold, not above', () => {
    const expectations = [exp('low', 40), exp('ok', 40)];
    const actuals = [
      { workerId: 'low', workedHours: 10 }, // 25% → under
      { workerId: 'ok', workedHours: 30 }, // 75% → fine
    ];
    const gaps = classifyCoverage(expectations, actuals, 0.6);
    expect(gaps.map((g) => g.workerId)).toEqual(['low']);
    expect(gaps[0]?.kind).toBe('under_coverage');
  });

  it('does not flag workers with no expected hours', () => {
    expect(classifyCoverage([exp('w1', 0)], [])).toHaveLength(0);
    expect(classifyCoverage([exp('w1', -5)], [])).toHaveLength(0);
  });

  it('treats meeting/exceeding the target as covered', () => {
    const gaps = classifyCoverage([exp('w1', 40)], [{ workerId: 'w1', workedHours: 40 }]);
    expect(gaps).toHaveLength(0);
    const over = classifyCoverage([exp('w2', 40)], [{ workerId: 'w2', workedHours: 50 }]);
    expect(over).toHaveLength(0);
  });

  it('sorts worst (lowest ratio) first', () => {
    const expectations = [exp('a', 40), exp('b', 40)];
    const actuals = [
      { workerId: 'a', workedHours: 8 }, // 20%
      { workerId: 'b', workedHours: 0 }, // 0%
    ];
    const gaps = classifyCoverage(expectations, actuals, 0.6);
    expect(gaps.map((g) => g.workerId)).toEqual(['b', 'a']);
  });
});
