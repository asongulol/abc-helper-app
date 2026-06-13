import { describe, expect, it } from 'vitest';
import { recomputeNetCentavos } from '../../../src/lib/payroll/row-net';

describe('recomputeNetCentavos', () => {
  it('returns null when gross is null (no rate)', () => {
    expect(
      recomputeNetCentavos({
        grossPhp: null,
        haPhp: 0,
        t13Php: 0,
        pddPhp: 0,
        bonusPhp: 0,
        miscItems: [],
      }),
    ).toBeNull();
  });

  it('computes net as gross+ha+t13+pdd+bonus+misc in centavos', () => {
    // 19000 + 1666.67 + 800 + 200 + 500 = 22166.67 PHP → 2216667 centavos
    const net = recomputeNetCentavos({
      grossPhp: 19000,
      haPhp: 1666.67,
      t13Php: 800,
      pddPhp: 200,
      bonusPhp: 500,
      miscItems: [],
    });
    expect(net).toBe(2216667);
  });

  it('subtracts deduction misc items', () => {
    // 10000 - 500 = 9500 PHP → 950000 centavos
    const net = recomputeNetCentavos({
      grossPhp: 10000,
      haPhp: 0,
      t13Php: 0,
      pddPhp: 0,
      bonusPhp: 0,
      miscItems: [{ kind: 'deduction', label: 'SSS', amount: 500 }],
    });
    expect(net).toBe(950000);
  });

  it('adds other_earns misc items', () => {
    // 10000 + 250 = 10250 PHP → 1025000 centavos
    const net = recomputeNetCentavos({
      grossPhp: 10000,
      haPhp: 0,
      t13Php: 0,
      pddPhp: 0,
      bonusPhp: 0,
      miscItems: [{ kind: 'other_earns', label: 'Bonus extra', amount: 250 }],
    });
    expect(net).toBe(1025000);
  });
});
