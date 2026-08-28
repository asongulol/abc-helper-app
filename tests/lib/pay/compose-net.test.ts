import { describe, expect, it } from 'vitest';
import { composeNetCentavos } from '../../../src/db/queries/payroll';
import { centavos } from '../../../src/lib/money';
import { composeNet, type MiscItem } from '../../../src/lib/pay/calc';
import { recomputeNetCentavos } from '../../../src/lib/payroll/row-net';

/**
 * Tri-parity: the three net composers are delegates of ONE formula (composeNet),
 * so identical component sets must produce identical nets — including the
 * no-rate row, where the one null rule (gross null ⇒ net null) applies.
 * composeNetCentavos sits out the null case only because its input is a
 * persisted payments row, whose gross is NOT NULL in the schema.
 */

type Case = {
  name: string;
  grossPhp: number | null;
  haPhp: number;
  t13Php: number;
  pddPhp: number;
  bonusPhp: number;
  miscItems: MiscItem[];
  offCyclePhp: number;
  expected: number | null; // centavos
};

const cases: Case[] = [
  {
    name: 'plain salaried row',
    grossPhp: 20_000,
    haPhp: 1_000,
    t13Php: 500,
    pddPhp: 250,
    bonusPhp: 100,
    miscItems: [],
    offCyclePhp: 0,
    expected: 2_185_000,
  },
  {
    name: 'misc earns + deduction + off-cycle ledger total',
    grossPhp: 20_000,
    haPhp: 1_000,
    t13Php: 500,
    pddPhp: 250,
    bonusPhp: 100,
    miscItems: [
      { kind: 'other_earns', amount: 300 },
      { kind: 'deduction', amount: 200 },
    ],
    offCyclePhp: 750,
    expected: 2_270_000,
  },
  {
    name: 'deductions can push net negative — never clamped',
    grossPhp: 100,
    haPhp: 0,
    t13Php: 0,
    pddPhp: 0,
    bonusPhp: 0,
    miscItems: [{ kind: 'deduction', amount: 500 }],
    offCyclePhp: 0,
    expected: -40_000,
  },
  {
    name: 'no-rate row: components never substitute for a price',
    grossPhp: null,
    haPhp: 1_000,
    t13Php: 500,
    pddPhp: 250,
    bonusPhp: 100,
    miscItems: [{ kind: 'other_earns', amount: 300 }],
    offCyclePhp: 750,
    expected: null,
  },
];

describe('composeNet tri-parity — engine, editable row, surgical write', () => {
  it.each(cases)('$name', (c) => {
    const parts = {
      healthAllowance: centavos(c.haPhp * 100),
      thirteenth: centavos(c.t13Php * 100),
      pddLunch: centavos(c.pddPhp * 100),
      bonus: centavos(c.bonusPhp * 100),
      misc: centavos(
        c.miscItems.reduce(
          (t, m) => t + (m.kind === 'deduction' ? -1 : 1) * Number(m.amount) * 100,
          0,
        ),
      ),
      offCycle: centavos(c.offCyclePhp * 100),
    };
    const canonical = composeNet(c.grossPhp === null ? null : centavos(c.grossPhp * 100), parts);
    expect(canonical).toBe(c.expected);

    // Surgical-write delegate (PHP-major PaymentComponents shape; persisted
    // rows only, where the schema guarantees a non-null gross).
    if (c.grossPhp !== null) {
      expect(
        composeNetCentavos(
          {
            grossPhp: c.grossPhp,
            haPhp: c.haPhp,
            t13Php: c.t13Php,
            pddPhp: c.pddPhp,
            bonusPhp: c.bonusPhp,
            miscItems: c.miscItems,
          },
          centavos(c.offCyclePhp * 100),
        ),
      ).toBe(canonical);
    }

    // Editable-row delegate (client shape).
    expect(
      recomputeNetCentavos({
        grossPhp: c.grossPhp,
        haPhp: c.haPhp,
        t13Php: c.t13Php,
        pddPhp: c.pddPhp,
        bonusPhp: c.bonusPhp,
        miscItems: c.miscItems,
        offCyclePhp: c.offCyclePhp,
      }),
    ).toBe(canonical);
  });
});
