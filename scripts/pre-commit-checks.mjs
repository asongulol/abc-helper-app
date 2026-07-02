#!/usr/bin/env node
/**
 * Staged-file hygiene gate (run in pre-commit via lefthook).
 *
 * Fast, staged-files-only checks that catch the mistakes CI is too late for:
 *  - SECRETS: obvious credentials in staged content (Supabase secret keys,
 *    Anthropic keys, private-key blocks, hardcoded token assignments).
 *  - ENV FILES: staging .env / .env.local etc. (.env.example is fine).
 *  - MIGRATIONS: bad filenames (macOS " 2.sql" duplicate copies abort
 *    `supabase db reset` at cutover; names must be <14-digit version>_<slug>.sql)
 *    and edits to already-committed migrations (history is append-only —
 *    write a new migration instead).
 *  - SIZE: staged files over 2 MB (fixtures/binaries don't belong in git).
 *
 * Usage: node scripts/pre-commit-checks.mjs <staged files...>
 * Pure Node, no deps — mirrors scripts/guardrails.mjs. Exits 1 on any hit.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const staged = process.argv.slice(2);
if (staged.length === 0) process.exit(0);

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|json|jsonc|sql|md|yml|yaml|toml|css|txt|env)$/i;

const SECRET_RULES = [
  { name: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'Hardcoded credential assignment',
    re: /\b(WISE_API_TOKEN|SUPABASE_SERVICE_KEY|HUBSTAFF_.*TOKEN|ANTHROPIC_API_KEY)\s*[:=]\s*['"][^'"\s]{12,}['"]/,
  },
];

const problems = [];

// Files already in HEAD (to distinguish new migrations from edits).
const inHead = new Set(
  execSync('git ls-tree -r --name-only HEAD', { encoding: 'utf8' }).split('\n').filter(Boolean),
);

for (const file of staged) {
  if (!existsSync(file)) continue; // deletions

  const name = basename(file);

  // .env files never belong in git (.env.example documents the shape).
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') {
    problems.push(`${file}: .env files must not be committed (use .env.example for the shape)`);
    continue;
  }

  // Migration hygiene.
  if (file.startsWith('supabase/migrations/')) {
    if (/ \d+\.sql$/.test(name)) {
      problems.push(
        `${file}: looks like a macOS duplicate copy — it will abort \`supabase db reset\` at cutover; delete it`,
      );
    } else if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(name)) {
      problems.push(`${file}: migration names must match <14-digit version>_<snake_case>.sql`);
    } else if (inHead.has(file)) {
      problems.push(
        `${file}: editing an already-committed migration rewrites history — add a NEW migration instead`,
      );
    }
  }

  // Size cap.
  const size = statSync(file).size;
  if (size > MAX_BYTES) {
    problems.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MB staged — files over 2 MB don't belong in git`);
    continue;
  }

  // Secrets scan (text files only; skip the lockfile and this script's rules).
  if (TEXT_EXT.test(name) && name !== 'pnpm-lock.yaml' && file !== 'scripts/pre-commit-checks.mjs') {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of SECRET_RULES) {
        if (rule.re.test(line)) problems.push(`${file}:${i + 1}: possible ${rule.name} staged`);
      }
    });
  }
}

if (problems.length > 0) {
  console.error(`\n✗ Pre-commit hygiene (${problems.length}):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nFix (or unstage) the files above and re-commit.\n');
  process.exit(1);
}
