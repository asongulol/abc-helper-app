/**
 * In-memory Supabase/PostgREST fake for service-layer tests (the PayrollDeps
 * seam). Implements exactly the builder surface src/db/queries uses today:
 * filters (eq/neq/lt/gte/lte/in/is/not), order/limit/range, single/maybeSingle,
 * insert/update/upsert/delete with `.select()` returning, `{ count }` selects,
 * and the embedded joins declared in RELATIONS. Anything else throws loudly —
 * extend it when a query grows a new verb, don't let it guess.
 *
 * Rows are plain objects; no column projection is performed (extra keys are
 * harmless to the mappers), only embeds are resolved.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Rel = { table: string; kind: 'one' | 'many'; local: string; foreign: string };

/** FK map for embedded selects like `workers(first_name, …)`. */
const RELATIONS: Record<string, Record<string, Rel>> = {
  worker_companies: {
    workers: { table: 'workers', kind: 'one', local: 'worker_id', foreign: 'id' },
  },
  payments: {
    workers: { table: 'workers', kind: 'one', local: 'worker_id', foreign: 'id' },
    pay_periods: { table: 'pay_periods', kind: 'one', local: 'pay_period_id', foreign: 'id' },
  },
  pay_periods: {
    companies: { table: 'companies', kind: 'one', local: 'company_id', foreign: 'id' },
  },
  off_cycle_pay_items: {
    workers: { table: 'workers', kind: 'one', local: 'worker_id', foreign: 'id' },
  },
  workers: {
    worker_companies: {
      table: 'worker_companies',
      kind: 'many',
      local: 'id',
      foreign: 'worker_id',
    },
  },
};

/** Split a select list on top-level commas: `a, b(c, d), e` → 3 entries. */
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

/** Shallow row copy with embedded relations attached (recursive). */
const project = (tables: Tables, table: string, row: Row, select: string): Row => {
  const out: Row = { ...row };
  if (select === '*') return out;
  for (const entry of splitTop(select)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(entry);
    if (!m) continue; // plain column — the whole-row copy already carries it
    const rel = RELATIONS[table]?.[m[1] as string];
    if (!rel) throw new Error(`supabase-fake: no relation ${table} -> ${m[1]}`);
    const related = (tables[rel.table] ?? []).filter((r) => r[rel.foreign] === row[rel.local]);
    const embedded = related.map((r) => project(tables, rel.table, r, (m[2] as string) || '*'));
    out[m[1] as string] = rel.kind === 'one' ? (embedded[0] ?? null) : embedded;
  }
  return out;
};

/** PostgREST `.not(col, 'in', '("a","b")')` list → values. */
const parseInList = (list: string): string[] =>
  list
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

const cmp = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last, either direction (good enough here)
  if (b == null) return -1;
  if (a === b) return 0;
  return (a as string | number) < (b as string | number) ? -1 : 1;
};

type Filter = (row: Row) => boolean;
type Result = { data: unknown; count?: number; error: { message: string } | null };

class FakeQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private cols = '*';
  private returning = false;
  private wantCount = false;
  private payload: Row[] = [];
  private patch: Row = {};
  private conflict: string[] = [];
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private window: { from: number; to: number } | null = null;
  private max: number | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(
    private tables: Tables,
    private table: string,
    private seq: { n: number },
  ) {}

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    this.cols = cols;
    if (this.op !== 'select') this.returning = true;
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.conflict = (opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push((r) => cmp(r[col], val) < 0 && r[col] != null);
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) >= 0);
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) <= 0);
    return this;
  }
  in(col: string, vals: readonly unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'in' && typeof val === 'string') {
      const list = parseInList(val);
      this.filters.push((r) => !list.includes(String(r[col])));
    } else if (op === 'is' && val === null) {
      this.filters.push((r) => r[col] != null);
    } else {
      throw new Error(`supabase-fake: .not('${col}', '${op}', …) unsupported`);
    }
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.window = { from, to };
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: supabase query builders ARE thenables — that's the contract being faked
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    try {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    } catch (e) {
      return Promise.reject(e).then(onfulfilled, onrejected);
    }
  }

  private withDefaults(r: Row): Row {
    this.seq.n += 1;
    return {
      id: `${this.table}-${this.seq.n}`,
      created_at: `2000-01-01T00:00:00.${String(this.seq.n).padStart(6, '0')}Z`,
      ...r,
    };
  }

  private run(): Result {
    this.tables[this.table] ??= [];
    const rows = this.tables[this.table] as Row[];
    const match = (r: Row) => this.filters.every((f) => f(r));
    const proj = (r: Row) => project(this.tables, this.table, r, this.cols);

    if (this.op === 'select') {
      let out = rows.filter(match);
      for (const o of [...this.orders].reverse()) {
        out = [...out].sort((a, b) => cmp(a[o.col], b[o.col]) * (o.asc ? 1 : -1));
      }
      const count = this.wantCount ? out.length : undefined;
      if (this.window) out = out.slice(this.window.from, this.window.to + 1);
      else if (this.max != null) out = out.slice(0, this.max);
      return this.finish(out.map(proj), count);
    }
    if (this.op === 'insert') {
      const stored = this.payload.map((r) => this.withDefaults(r));
      rows.push(...stored);
      return this.finish(stored.map(proj));
    }
    if (this.op === 'upsert') {
      const stored: Row[] = [];
      for (const r of this.payload) {
        const hit = rows.find((row) => this.conflict.every((c) => row[c] === r[c]));
        if (hit) {
          Object.assign(hit, r);
          stored.push(hit);
        } else {
          const row = this.withDefaults(r);
          rows.push(row);
          stored.push(row);
        }
      }
      return this.finish(stored.map(proj));
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.patch);
      return this.finish(hit.map(proj));
    }
    // delete
    const hit = rows.filter(match);
    this.tables[this.table] = rows.filter((r) => !hit.includes(r));
    return this.finish(hit.map(proj));
  }

  private finish(out: Row[], count?: number): Result {
    if (this.op !== 'select' && !this.returning) return { data: null, error: null };
    if (this.mode === 'many') {
      return count === undefined ? { data: out, error: null } : { data: out, count, error: null };
    }
    if (out.length > 1) {
      return {
        data: null,
        error: { message: `supabase-fake: ${this.table} expected 1 row, got ${out.length}` },
      };
    }
    if (out.length === 0) {
      return this.mode === 'maybe'
        ? { data: null, error: null }
        : { data: null, error: { message: `supabase-fake: ${this.table} single() got 0 rows` } };
    }
    return { data: out[0], error: null };
  }
}

/**
 * A fake client plus its live table store. Mutations made by the code under
 * test are visible in `tables` for assertions; the seed is deep-copied.
 */
export const fakeSupabase = (
  seed: Tables = {},
): { client: SupabaseClient<Database>; tables: Tables } => {
  const tables: Tables = structuredClone(seed);
  const seq = { n: 0 };
  const client = {
    from: (table: string) => new FakeQuery(tables, table, seq),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  } as unknown as SupabaseClient<Database>;
  return { client, tables };
};
