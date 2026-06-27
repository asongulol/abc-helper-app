#!/usr/bin/env node
/**
 * Prod-migration drift gate (run in pre-push; enforced on `main`).
 *
 * The deploy pipeline ships CODE to Vercel on every push to `main`, but it does
 * NOT apply database migrations — prod's schema history is DISJOINT from this
 * repo (conformed via the shared-prod work; `supabase db push` is never run on
 * prod). That gap once shipped code that read `payments.off_cycle_php` before the
 * column existed in prod, breaking the live payroll editor + Calculate.
 *
 * This gate blocks pushing to `main` while any migration newer than the recorded
 * baseline isn't marked as applied to prod in supabase/prod-applied.json. To
 * clear it: run the migration's (additive) DDL on prod via the Supabase SQL
 * Editor / MCP, record its version prefix in that file, then push. On non-main
 * branches it only warns (exit 0) so feature work isn't impeded.
 *
 * Pure Node, no deps — mirrors scripts/guardrails.mjs.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const MIG_DIR = 'supabase/migrations';
const LEDGER = 'supabase/prod-applied.json';

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const baseline = ledger.baselineThrough ?? '00000000000000';
const applied = new Set(Object.keys(ledger.applied ?? {}));

// Unique migration versions. Version prefixes are fixed-width zero-padded, so a
// lexicographic compare is also a numeric compare. Skip macOS " 2.sql" copies.
const versions = new Set();
for (const f of readdirSync(MIG_DIR)) {
  if (!f.endsWith('.sql') || / \d+\.sql$/.test(f)) continue;
  const m = /^(\d+)_/.exec(f);
  if (m) versions.add(m[1]);
}

const pending = [...versions].filter((v) => v > baseline && !applied.has(v)).sort();
if (pending.length === 0) process.exit(0);

let branch = '';
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* detached HEAD / no git — treat as non-main (warn only) */
}

const msg = [
  '',
  '✖ Prod-migration drift — these migrations are not recorded as applied to prod:',
  ...pending.map((v) => `    • ${v}`),
  '',
  'The deploy ships code but NOT schema. Before this reaches main/prod:',
  "  1. Run the migration's additive DDL on prod (Supabase SQL Editor / MCP).",
  `  2. Add its version to "applied" in ${LEDGER}.`,
  '',
].join('\n');

if (branch === 'main') {
  console.error(msg);
  console.error('Blocking push to main until the above are recorded.\n');
  process.exit(1);
}
console.warn(msg);
console.warn(`(warning only on "${branch || 'detached HEAD'}"; this blocks on main)\n`);
process.exit(0);
