#!/usr/bin/env node
/**
 * Security guardrail gate (run in pre-push + CI).
 *
 * Fails the build if forbidden patterns appear in scanned roots:
 *  - A Wise FUNDING call. Money movement is DRAFT-ONLY (ADR-0007): the app prepares
 *    quotes/recipients/transfers and the owner funds in the Wise UI. No funding endpoint may exist.
 *  - A secret exposed via a NEXT_PUBLIC_* env var (those are shipped to the browser).
 *
 * Pure Node, no deps. Exits 1 (with file:line) on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

// Scan the app source AND the cron edge functions — wise-payouts reconciles
// payouts, so the DRAFT-ONLY (ADR-0007) rule must hold there too.
const ROOTS = ['src', 'supabase/functions'];
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const RULES = [
  {
    name: 'Wise funding call (money movement must be draft-only — ADR-0007)',
    re: /\bfundTransfer\b|\bfundWithBalance\b|\.fund\s*\(|\/transfers\/[^'"`\n]*\/payments\b/,
  },
  {
    name: 'Secret exposed via a NEXT_PUBLIC_ env var',
    re: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|SERVICE_KEY|PRIVATE|PASSWORD)/,
  },
];

/** @param {string} dir @param {string[]} out */
const walk = (dir, out) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.has(extname(full))) out.push(full);
  }
};

const files = [];
for (const root of ROOTS) {
  if (existsSync(root)) walk(root, files);
}

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push(`${file}:${i + 1}  ${rule.name}\n    ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`\n✗ Guardrail violations (${violations.length}):\n`);
  for (const v of violations) console.error(`  ${v}\n`);
  process.exit(1);
}
// biome-ignore lint/suspicious/noConsole: intentional CLI success output
console.log(`✓ Guardrails clean (${files.length} files scanned).`);
