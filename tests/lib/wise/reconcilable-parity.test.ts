import { describe, expect, it } from 'vitest';
import {
  isReadyToReconcile,
  READY_TO_RECONCILE_OR,
  type ReconcilableRow,
} from '@/lib/wise/reconcilable';

/**
 * reconcileAllPending's bulk UPDATE restates `isReadyToReconcile` in PostgREST
 * syntax: .eq(status,'sent') + .not(paid_at,is,null) + .or(READY_TO_RECONCILE_OR).
 * This evaluates the ACTUAL exported string — under SQL semantics — against the
 * full truth table of the predicate's inputs, so editing either copy alone
 * fails here (pattern: vendored-parity.test.ts).
 *
 * SQL semantics are the point: `neq.wise` is NOT JS `!== 'wise'` — a NULL
 * column fails a SQL `<>`, which is why the string carries its own
 * `payout_method.is.null` disjunct. A JS-equality evaluator would let that
 * disjunct vanish without failing.
 */

type Row = Record<string, unknown>;

/** Split on top-level commas so `and(a,b)` stays one condition. */
const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
};

/** The PostgREST subset the string uses; anything new throws — extend me. */
const evalCond = (cond: string, row: Row): boolean => {
  const and = /^and\((.*)\)$/s.exec(cond);
  if (and) return splitTop(and[1] as string).every((c) => evalCond(c, row));
  let m = /^(\w+)\.is\.null$/.exec(cond);
  if (m) return row[m[1] as string] == null;
  m = /^(\w+)\.not\.is\.null$/.exec(cond);
  if (m) return row[m[1] as string] != null;
  m = /^(\w+)\.neq\.(.+)$/.exec(cond);
  if (m) return row[m[1] as string] != null && row[m[1] as string] !== m[2];
  throw new Error(`parity evaluator: unsupported condition '${cond}'`);
};

// Eager map (not .some(evalCond)) so a malformed later disjunct still throws.
const orMatches = (or: string, row: Row): boolean =>
  splitTop(or)
    .map((c) => evalCond(c, row))
    .some(Boolean);

describe('READY_TO_RECONCILE_OR mirrors isReadyToReconcile', () => {
  it('agrees with the predicate on the full truth table', () => {
    for (const status of ['sent', 'draft', 'reconciled']) {
      for (const paid_at of ['2026-07-15', null]) {
        for (const payout_method of [null, 'wise', 'bpi']) {
          for (const wise_transfer_id of [null, '2276187411']) {
            for (const wise_locked_at of [null, '2026-07-16T00:00:00Z']) {
              const row: ReconcilableRow = {
                status,
                paid_at,
                payout_method,
                wise_transfer_id,
                wise_locked_at,
              };
              const sql =
                row.status === 'sent' &&
                row.paid_at != null &&
                orMatches(READY_TO_RECONCILE_OR, row);
              expect(sql, JSON.stringify(row)).toBe(isReadyToReconcile(row));
            }
          }
        }
      }
    }
  });
});
