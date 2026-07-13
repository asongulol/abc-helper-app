/**
 * E2E: /time review is scoped to the arrears period, with an "all unpaid" toggle.
 *
 * Regression guard for feat/time-review-period-scope: the review list must default
 * to the PRECEDING half-month (payroll runs in arrears), be period-scoped, and the
 * "Show all unpaid" toggle must span periods while excluding time already in a
 * locked/paid period.
 *
 * This is a live-stack test (real app + real local DB), NOT a vitest unit test — it
 * lives under e2e/ so vitest's `tests/**` glob never picks it up. It is
 * date-relative (computes the arrears period from today) and self-seeding, so it
 * passes on any calendar day and needs no manual fixture.
 *
 * Prerequisites (local only):
 *   1. `supabase start`            — local stack at 127.0.0.1:54321
 *   2. `npm run dev:bootstrap`     — owner login + seeded workers
 *   3. `npm run dev`               — app on http://localhost:3000
 * Then:  npm run e2e:time-review
 */
import { readFileSync } from 'node:fs';
import pw from 'playwright';

const { chromium } = pw;
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT = new URL('.', import.meta.url).pathname;

// Stable fixture ids. Workers + the client come from `npm run dev:bootstrap`.
const EMPLOYER = 'e0000000-0000-0000-0000-0000000000e2';
const WORKER = 'a0000000-0000-0000-0000-000000000001';
const NAME = 'Maria Santos';
// Per-session contractor (contract 'PS') + billed client — drives the
// "Recently added sessions" list, which is period-scoped the same way.
const WORKER_PS = 'a0000000-0000-0000-0000-000000000002';
const CLIENT = 'c0000000-0000-0000-0000-000000000001';

// ── Semi-monthly period math (mirror of src/lib/dates/periods.ts, kept tiny) ──
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const periodFor = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return d <= 15
    ? { start: iso(y, m, 1), end: iso(y, m, 15) }
    : { start: iso(y, m, 16), end: iso(y, m, lastDay(y, m)) };
};
const toMs = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const toIso = (ms) => {
  const dt = new Date(ms);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};
const prev = (p) => periodFor(toIso(toMs(p.start) - 86_400_000));

const today = new Date().toISOString().slice(0, 10);
const cur = periodFor(today); // in-progress period (the OLD, buggy default)
const arrears = prev(cur); // the correct default
const paid = prev(arrears); // marked paid → its approved time is excluded from "unpaid"
const older = prev(paid); // a still-open older period → its pending time shows in "unpaid"

// ── Supabase REST (service key bypasses RLS; local stack only) ────────────────
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_KEY;
if (!/(127\.0\.0\.1|localhost)/.test(URL_ ?? '')) throw new Error(`refusing non-local DB: ${URL_}`);
const rest = (path, opts = {}) =>
  fetch(`${URL_}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  }).then(async (r) => {
    if (!r.ok)
      throw new Error(`REST ${opts.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`);
    return r;
  });

const entry = (work_date, tracked_seconds, approval) => ({
  company_id: EMPLOYER,
  worker_id: WORKER,
  source_name: NAME,
  work_date,
  tracked_seconds,
  approval,
});

const seed = async () => {
  // Structure (idempotent — leave if present).
  await rest('companies?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      id: EMPLOYER,
      name: 'E2E Employer (time-review)',
      status: 'active',
      kind: 'employer',
    }),
  });
  await rest('worker_companies?on_conflict=company_id,worker_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      company_id: EMPLOYER,
      worker_id: WORKER,
      contract: 'FT',
      status: 'active',
      role: 'Developer',
      hubstaff_name: NAME,
    }),
  });
  // Volatile — clear then insert so re-runs start clean and stay date-correct.
  await rest(`time_entries?company_id=eq.${EMPLOYER}`, { method: 'DELETE' });
  await rest(`pay_periods?company_id=eq.${EMPLOYER}`, { method: 'DELETE' });
  await rest('pay_periods', {
    method: 'POST',
    body: JSON.stringify({
      company_id: EMPLOYER,
      period_start: paid.start,
      period_end: paid.end,
      state: 'paid',
    }),
  });
  await rest('time_entries', {
    method: 'POST',
    body: JSON.stringify([
      entry(arrears.start, 3600, 'pending'), //   1.00h — the arrears default view
      entry(cur.start, 10800, 'approved'), //     3.00h — open period, shows only in "unpaid"
      entry(older.start, 7200, 'pending'), //     2.00h — pending in older period, "unpaid" only
      entry(paid.start, 36000, 'approved'), //   10.00h — in a PAID period → excluded from "unpaid"
    ]),
  });

  // Per-session contractor + two unpaid sessions (one in the arrears period, one
  // in a far older period) to prove the "Recently added sessions" list scopes too.
  await rest('worker_companies?on_conflict=company_id,worker_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      company_id: EMPLOYER,
      worker_id: WORKER_PS,
      contract: 'PS',
      status: 'active',
      role: 'Therapist',
      hubstaff_name: 'Jose Rizal',
    }),
  });
  await rest(`service_sessions?worker_id=eq.${WORKER_PS}`, { method: 'DELETE' });
  await rest('service_sessions', {
    method: 'POST',
    body: JSON.stringify([
      {
        company_id: CLIENT,
        worker_id: WORKER_PS,
        session_date: arrears.start,
        session_type: 'Initial IFSP',
        units: 1,
        child_initials: 'INPER',
        eiid: 'EI-IN',
        approval: 'pending',
      },
      {
        company_id: CLIENT,
        worker_id: WORKER_PS,
        session_date: older.start,
        session_type: 'Initial IFSP',
        units: 1,
        child_initials: 'OUTPER',
        eiid: 'EI-OUT',
        approval: 'pending',
      },
    ]),
  });
};

const results = [];
const check = (name, cond, detail = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
// Wait briefly for a locator to become visible (async client-side refetch).
const seen = (loc) =>
  loc
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

// Preflight: fail with a clear message if the app isn't up.
await fetch(`${BASE}/login`).catch(() => {
  throw new Error(
    `app not reachable at ${BASE} — start it with \`npm run dev\` (see prereqs in this file).`,
  );
});
await seed();

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(15000);
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('owner@abckidsny.com');
  await page.getByLabel('Password').fill('devpassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  check('login redirects away from /login', !page.url().includes('/login'), page.url());

  // Default view = arrears, period-scoped.
  await page.goto(`${BASE}/time`, { waitUntil: 'networkidle' });
  const review = () => page.getByRole('button', { name: /Review & Approve/ });
  const label1 = (await review().innerText()).replace(/\s+/g, ' ');
  check(
    `default period is the arrears half-month ${arrears.start} – ${arrears.end}`,
    label1.includes(`${arrears.start} – ${arrears.end}`),
    label1,
  );
  check(
    `default is NOT the in-progress period ${cur.start} – ${cur.end}`,
    !label1.includes(`${cur.start} – ${cur.end}`),
    label1,
  );
  await page.screenshot({ path: `${OUT}/shot-1-default.png`, fullPage: true });

  await review().click();
  const rowDefault = (await page.getByRole('row', { name: new RegExp(NAME) }).innerText()).replace(
    /\s+/g,
    ' ',
  );
  check('arrears view: total is 1.00h (period-scoped)', /\b1\.00\b/.test(rowDefault), rowDefault);
  check(
    'arrears view: excludes cross-period hours (no 6.00/16.00)',
    !/\b(6|16)\.00\b/.test(rowDefault),
    rowDefault,
  );

  // Session list is period-scoped too.
  check(
    'arrears view: session list shows the in-period session',
    await seen(page.getByText('INPER')),
  );
  check(
    'arrears view: session list HIDES the out-of-period session',
    (await page.getByText('OUTPER').count()) === 0,
  );

  // Toggle: all unpaid (cross-period, coverage hidden, paid excluded).
  await page.getByRole('button', { name: 'Show all unpaid' }).click();
  await page.waitForURL(/unpaid=1/, { timeout: 20000 });
  const label2 = (await review().innerText()).replace(/\s+/g, ' ');
  check(
    'unpaid view: header reads "all unpaid periods"',
    label2.includes('all unpaid periods'),
    label2,
  );
  check(
    'unpaid view: "spanning multiple periods" note shown',
    await page.getByText(/spanning multiple periods/).isVisible(),
  );
  check(
    'unpaid view: period picker hidden',
    !(await page
      .getByRole('button', { name: /Prev/ })
      .isVisible()
      .catch(() => false)),
  );
  const rowUnpaid = (await page.getByRole('row', { name: new RegExp(NAME) }).innerText()).replace(
    /\s+/g,
    ' ',
  );
  check(
    'unpaid view: total is 6.00h (arrears + open + older pending)',
    /\b6\.00\b/.test(rowUnpaid),
    rowUnpaid,
  );
  check(
    'unpaid view: EXCLUDES the paid-period entry (would be 16.00h)',
    !/\b16\.00\b/.test(rowUnpaid),
    rowUnpaid,
  );

  // Session list spans periods in "all unpaid" mode.
  check(
    'unpaid view: session list shows the in-period session',
    await seen(page.getByText('INPER')),
  );
  check(
    'unpaid view: session list shows the out-of-period session too',
    await seen(page.getByText('OUTPER')),
  );
  await page.screenshot({ path: `${OUT}/shot-2-unpaid.png`, fullPage: true });

  // Toggle back.
  await page.getByRole('button', { name: /Back to period view/ }).click();
  await page.waitForURL((u) => !u.search.includes('unpaid'), { timeout: 20000 });
  const label3 = (await review().innerText()).replace(/\s+/g, ' ');
  check(
    'back-to-period restores the arrears view',
    label3.includes(`${arrears.start} – ${arrears.end}`),
    label3,
  );
} catch (err) {
  check('script ran without error', false, String(err));
  await page.screenshot({ path: `${OUT}/shot-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed.`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
