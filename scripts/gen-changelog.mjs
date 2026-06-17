#!/usr/bin/env node
/**
 * AI changelog generator.
 *
 * Summarizes the git diff of what you're about to push into a plain-English
 * CHANGELOG.md entry, using the @anthropic-ai/sdk already in package.json.
 *
 * Token cost scales with diff SIZE only (we never send the whole repo, exclude
 * lockfiles/build output, and hard-cap the diff). Typically pennies per push.
 *
 * Wired into lefthook pre-push (best-effort; never blocks a push). Also runnable:
 *     pnpm changelog
 *
 * Requires ANTHROPIC_API_KEY in the environment. If it's missing, the script
 * exits 0 quietly so pushes are never blocked by a missing key.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MAX_DIFF_CHARS = 12_000;
const MODEL = 'claude-haiku-4-5-20251001';

function sh(cmd) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function quietExit(msg) {
  if (msg) console.error(`[gen-changelog] ${msg}`);
  process.exit(0); // never block the push
}

if (!process.env.ANTHROPIC_API_KEY) {
  quietExit('ANTHROPIC_API_KEY not set; skipping changelog (push continues).');
}

// Diff range: since the last changelog marker tag, else the last commit.
let range;
try {
  const lastTag = sh("git tag --list 'changelog-*' --sort=-creatordate").split('\n')[0];
  range = lastTag ? `${lastTag}..HEAD` : 'HEAD~1..HEAD';
} catch {
  range = 'HEAD~1..HEAD';
}

let diff = '';
try {
  const excludes =
    "':(exclude)pnpm-lock.yaml' ':(exclude).next/**' " +
    "':(exclude)dist/**' ':(exclude)node_modules/**' ':(exclude)*.tsbuildinfo'";
  diff = execSync(`git diff ${range} -- . ${excludes}`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  quietExit('Could not compute diff; skipping.');
}

diff = diff.slice(0, MAX_DIFF_CHARS);
if (!diff.trim()) quietExit('No meaningful diff to document; skipping.');

const instructions =
  'You are writing a changelog entry for a contractor-management, payroll, and ' +
  'facility-invoicing app (Next.js + Supabase; money movement is draft-only). ' +
  'Given the git diff below, write a concise plain-English summary of what changed ' +
  'and why it matters. Group under headings Added / Changed / Fixed (omit any that ' +
  'do not apply). Short bullet points. Do not invent changes absent from the diff.';
const prompt = `${instructions}\n\n${diff}`;

// Lazy-load the SDK: it's an optional, best-effort dependency, so resolve it at
// runtime (after the key check) rather than via a top-level import. A missing
// package must exit 0 quietly — a static import would throw ERR_MODULE_NOT_FOUND
// at load time, before any guard runs, and block the push.
let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  quietExit('@anthropic-ai/sdk not installed; skipping changelog (push continues).');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let note;
try {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });
  note = res.content?.find((b) => b.type === 'text')?.text?.trim();
} catch (err) {
  quietExit(`API call failed (${err?.message ?? err}); leaving CHANGELOG.md untouched.`);
}

if (!note) quietExit('Empty summary from API; skipping.');

const date = new Date().toISOString().slice(0, 10);
const sha = (() => {
  try {
    return sh('git rev-parse --short HEAD');
  } catch {
    return '';
  }
})();

const existing = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '';
writeFileSync('CHANGELOG.md', `## ${date} (${sha})\n\n${note}\n\n${existing}`);

try {
  sh('git add CHANGELOG.md');
  execSync(`git commit -m "docs: update changelog (${sha})"`, {
    stdio: 'ignore',
  });
  execSync(
    `git tag "changelog-${new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 14)}"`,
    {
      stdio: 'ignore',
    },
  );
} catch {
  /* commit/tag is best-effort */
}

console.error('[gen-changelog] CHANGELOG.md updated.');
