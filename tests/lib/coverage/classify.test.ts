import { describe, expect, it } from 'vitest';
import { classifyCoverage } from '@/lib/coverage/classify';

const exp = (workerId: string, expectedHours: number, workerName = workerId) => ({
  workerId,
  workerName,
  expectedHours,
});

const act = (workerId: string, workedHours: number, ptoHours = 0) => ({
  workerId,
  workedHours,
  ptoHours,
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
      act('low', 10), // 25% → under
      act('ok', 30), // 75% → fine
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
    expect(classifyCoverage([exp('w1', 40)], [act('w1', 40)])).toHaveLength(0);
    expect(classifyCoverage([exp('w2', 40)], [act('w2', 50)])).toHaveLength(0);
  });

  it('sorts worst (lowest ratio) first', () => {
    const expectations = [exp('a', 40), exp('b', 40)];
    const actuals = [
      act('a', 8), // 20%
      act('b', 0), // 0%
    ];
    const gaps = classifyCoverage(expectations, actuals, 0.6);
    expect(gaps.map((g) => g.workerId)).toEqual(['b', 'a']);
  });
});

describe('classifyCoverage — PTO counts toward coverage', () => {
  it('does not flag a contractor who was on approved leave all period', () => {
    expect(classifyCoverage([exp('w1', 40)], [act('w1', 0, 40)])).toHaveLength(0);
  });

  it('does not flag when worked + PTO clears the target, though worked alone would not', () => {
    expect(classifyCoverage([exp('w1', 40)], [act('w1', 8)], 0.6)).toHaveLength(1); // 20%
    expect(classifyCoverage([exp('w1', 40)], [act('w1', 8, 24)], 0.6)).toHaveLength(0); // 80%
  });

  it('still flags when worked + PTO is short, and reports the two separately', () => {
    const gaps = classifyCoverage([exp('w1', 40)], [act('w1', 4, 4)], 0.6); // 20%
    expect(gaps[0]).toMatchObject({
      kind: 'under_coverage',
      workedHours: 4,
      ptoHours: 4,
      ratio: 0.2,
    });
  });

  it('zero_time means nothing at all recorded — PTO-only is under_coverage, not zero', () => {
    const [gap] = classifyCoverage([exp('w1', 40)], [act('w1', 0, 4)], 0.6);
    expect(gap).toMatchObject({ kind: 'under_coverage', workedHours: 0, ptoHours: 4 });
  });
});
