/**
 * E2E: contract-change wizard slice 5 — the Access step with its editable
 * login email, the rehire prefill and dates, and the expiring-documents list
 * (docs/CONTRACT-CHANGE-WIZARD-PLAN.md §0.11–0.12).
 *
 * Live-stack test (real app + real LOCAL DB), not a vitest unit test — it lives
 * under e2e/ so vitest's `tests/**` glob never picks it up. Self-seeding and
 * re-runnable: every run puts the login email back and clears what it drafted.
 *
 * Prerequisites (local only):
 *   1. `supabase start`
 *   2. `pnpm dev:bootstrap` + `node scripts/dev-seed-contractor.mjs`
 *   3. `pnpm dev`
 * Then:  pnpm e2e:contract-wizard
 */
import { readFileSync } from 'node:fs';
import pw from 'playwright';

const { chromium } = pw;
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT = new URL('.', import.meta.url).pathname;

// The single employer every admin page operates on (shared with time-review.e2e).
const EMPLOYER = 'e0000000-0000-0000-0000-0000000000e2';
// Current contractor with a portal login (scripts/dev-seed-contractor.mjs).
const MARIA = 'a0000000-0000-0000-0000-000000000001';
const MARIA_EMAIL = 'maria@abckidsny.com';
const CHANGED_EMAIL = 'maria.changed@abckidsny.com';
// Ended engagement whose last contract is a versioned row — the rehire prefill source.
const REHIRE = 'a0000000-0000-0000-0000-0000000e2e05';
const REHIRE_EMAIL = 'rehire.tester@example.com';

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
const call = (path, opts = {}) =>
  fetch(`${URL_}/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${opts.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`);
    return r;
  });
const rest = (path, opts) => call(`rest/v1/${path}`, opts);
const ignoreDup = (body) => ({
  method: 'POST',
  headers: { Prefer: 'resolution=ignore-duplicates' },
  body: JSON.stringify(body),
});
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body) => ({ method: 'PATCH', body: JSON.stringify(body) });
const isoPlus = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** The three places the login email lives — what updatePortalEmail writes. */
const setLoginEmail = async (email) => {
  const [login] = await rest(`contractor_logins?worker_id=eq.${MARIA}&select=auth_user_id`).then(
    (r) => r.json(),
  );
  if (login?.auth_user_id)
    await call(`auth/v1/admin/users/${login.auth_user_id}`, {
      method: 'PUT',
      body: JSON.stringify({ email, email_confirm: true }),
    });
  await rest(`contractor_logins?worker_id=eq.${MARIA}`, patch({ email }));
  await rest(`workers?id=eq.${MARIA}`, patch({ email }));
};

const seed = async () => {
  await rest(
    'companies?on_conflict=id',
    ignoreDup({
      id: EMPLOYER,
      name: 'E2E Employer (time-review)',
      status: 'active',
      kind: 'employer',
    }),
  );
  await rest(
    'worker_companies?on_conflict=company_id,worker_id',
    ignoreDup({
      company_id: EMPLOYER,
      worker_id: MARIA,
      contract: 'FT',
      status: 'active',
      role: 'Developer',
      hubstaff_name: 'Maria Santos',
    }),
  );
  // A previous run changed the email and left a draft; New contract needs nothing in flight.
  await setLoginEmail(MARIA_EMAIL);
  await rest(
    `contract_versions?worker_id=eq.${MARIA}&company_id=eq.${EMPLOYER}&status=in.(draft,sent,signed)`,
    { method: 'DELETE' },
  );
  // Expiring documents: a renewed NBI (old copy expired, newest valid) must NOT
  // be listed; a passport expiring in 10 days must.
  await rest(`documents?worker_id=eq.${MARIA}&title=like.E2E*`, { method: 'DELETE' });
  await rest(
    'documents',
    post([
      {
        worker_id: MARIA,
        kind: 'nbi_clearance',
        title: 'E2E NBI Clearance',
        expires_on: isoPlus(-10),
        review_status: 'approved',
      },
      {
        worker_id: MARIA,
        kind: 'nbi_clearance',
        title: 'E2E NBI Clearance',
        expires_on: isoPlus(200),
        review_status: 'approved',
      },
      {
        worker_id: MARIA,
        kind: 'gov_id',
        title: 'E2E Passport',
        expires_on: isoPlus(10),
        review_status: 'approved',
      },
    ]),
  );
  // Request a document refuses a title already on the owed list.
  await rest(`onboarding_progress?worker_id=eq.${MARIA}`, patch({ extra_documents: [] }));

  // The rehire: ended link, closed rate, and an ended version 2 with terms that
  // differ from the link's role — the wizard must prefill from the version.
  await rest(
    'workers?on_conflict=id',
    ignoreDup({
      id: REHIRE,
      first_name: 'Rehire',
      last_name: 'Tester',
      status: 'ended',
      hire_date: '2025-01-01',
      email: REHIRE_EMAIL,
    }),
  );
  await rest(
    'worker_companies?on_conflict=company_id,worker_id',
    ignoreDup({
      company_id: EMPLOYER,
      worker_id: REHIRE,
      contract: 'FT',
      status: 'ended',
      ended_on: '2026-06-30',
      role: 'Old Role',
      hubstaff_name: 'Rehire Tester',
    }),
  );
  await rest(`rates?worker_id=eq.${REHIRE}`, { method: 'DELETE' });
  await rest(
    'rates',
    post({
      worker_id: REHIRE,
      company_id: EMPLOYER,
      amount_php: 15000,
      period_basis: 'semi_monthly',
      effective_start: '2025-01-01',
      effective_end: '2026-06-30',
    }),
  );
  await rest(`contract_versions?worker_id=eq.${REHIRE}`, { method: 'DELETE' });
  await rest(
    'contract_versions',
    post({
      worker_id: REHIRE,
      company_id: EMPLOYER,
      version: 2,
      status: 'ended',
      rate_php: 17500,
      position: 'Senior Ended Position',
      employment_type: 'PT',
      schedule: 'Ended 9-5',
      hours_per_week: 30,
      start_date: '2025-01-01',
      effective_from: '2025-01-01',
      ended_on: '2026-06-30',
      notice_days: 30,
      change_reason: 'terms_change',
      health_allowance: false,
      thirteenth_month: true,
      holiday_pay: true,
      pto_days_per_year: 20,
    }),
  );
};

const results = [];
const check = (name, cond, detail = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const seen = (loc) =>
  loc
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

await fetch(`${BASE}/login`).catch(() => {
  throw new Error(`app not reachable at ${BASE} — start it with \`pnpm dev\`.`);
});
await seed();

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(15000);
const val = (sel) => page.locator(sel).inputValue();
const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
const openWizard = async (workerId) => {
  await page.goto(`${BASE}/contractors/${workerId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Contracts' }).click();
  await page.getByRole('button', { name: 'New contract' }).click();
};
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('owner@abckidsny.com');
  await page.getByLabel('Password').fill('devpassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });

  // ── Flow 1: current contractor — expiring documents, Access step, email edit ──
  await openWizard(MARIA);
  await page.getByLabel('Change in terms').check();
  await next();
  check('terms: start date prefilled for a current contractor', (await val('#cv-start')) !== '');
  await next();
  await page.fill('#cv-value', '25000');
  await next();
  await next(); // Benefits
  check(
    'package: renewed document (newest copy valid) is NOT listed',
    (await page.getByText('E2E NBI Clearance').count()) === 0,
  );
  check(
    'package: document expiring in 10 days is listed',
    await seen(page.getByText('E2E Passport')),
  );
  await page
    .getByRole('listitem')
    .filter({ hasText: 'E2E Passport' })
    .getByRole('button', { name: 'Request', exact: true })
    .click();
  check(
    'package: Request flips to Requested',
    await seen(page.getByRole('button', { name: 'Requested' })),
  );
  await next();
  check('access: badge shows Access active', await seen(page.getByText('Access active')));
  check(
    'access: login email prefilled',
    (await val('#cv-email')) === MARIA_EMAIL,
    await val('#cv-email'),
  );
  check('access: last sign-in shown', await page.getByText(/Last sign-in/).isVisible());
  check(
    'access: send line names the active login',
    await page.getByText(`Send emails the contract to ${MARIA_EMAIL}`).isVisible(),
  );
  check(
    'access: Save disabled while unchanged',
    await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
  );
  await page.fill('#cv-email', CHANGED_EMAIL);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  check(
    'access: toast confirms the login email change',
    await seen(page.getByText('Login email changed.')),
  );
  check(
    'access: send line follows the new email',
    await seen(page.getByText(`Send emails the contract to ${CHANGED_EMAIL}`)),
  );
  await page.screenshot({ path: `${OUT}/shot-wizard-access.png`, fullPage: true });
  await next();
  check(
    'review: access line repeated',
    await seen(page.getByText(`Send emails the contract to ${CHANGED_EMAIL}`)),
  );
  await page.getByRole('button', { name: 'Save draft' }).click();
  check('review: draft saved', await seen(page.getByText(/Draft saved — version \d+/)));
  await page.getByRole('tab', { name: 'Portal & login' }).click();
  check('portal tab: shows the new login email', await seen(page.getByText(CHANGED_EMAIL)));
  check(
    'portal tab: access history has the change row',
    await seen(page.getByRole('cell', { name: 'Login email changed' })),
  );
  await page.screenshot({ path: `${OUT}/shot-wizard-portal-tab.png`, fullPage: true });
  const [login] = await rest(`contractor_logins?worker_id=eq.${MARIA}&select=email`).then((r) =>
    r.json(),
  );
  const [worker] = await rest(`workers?id=eq.${MARIA}&select=email`).then((r) => r.json());
  check(
    'db: login row and worker row both carry the new email',
    login?.email === CHANGED_EMAIL && worker?.email === CHANGED_EMAIL,
    `${login?.email} / ${worker?.email}`,
  );

  // ── Flow 2: rehire — prefill from the ended version, blank start date that the effective date follows ──
  await openWizard(REHIRE);
  check('rehire: reason preselected', await page.getByLabel('Rehire').isChecked());
  await next();
  check(
    'rehire: position from the ended version, not the link',
    (await val('#cv-position')) === 'Senior Ended Position',
    await val('#cv-position'),
  );
  check('rehire: employment type from the ended version', (await val('#cv-type')) === 'PT');
  check('rehire: hours from the ended version', (await val('#cv-hours')) === '30');
  check('rehire: notice days from the ended version', (await val('#cv-notice')) === '30');
  check('rehire: start date blank', (await val('#cv-start')) === '');
  check('rehire: effective date blank', (await val('#cv-effective')) === '');
  check(
    'rehire: Next disabled until the dates are entered',
    await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(),
  );
  await page.fill('#cv-start', '2026-10-01');
  check(
    'rehire: effective date follows the start date',
    (await val('#cv-effective')) === '2026-10-01',
    await val('#cv-effective'),
  );
  await page.fill('#cv-effective', '2026-10-16');
  await page.fill('#cv-start', '2026-10-02');
  check(
    'rehire: effective date edited on its own stops following',
    (await val('#cv-effective')) === '2026-10-16',
    await val('#cv-effective'),
  );
  await next();
  check(
    'rehire: rate from the ended version',
    (await val('#cv-value')) === '17500',
    await val('#cv-value'),
  );
  await next();
  check('rehire: PTO days from the ended version', (await val('#cv-pto')) === '20');
  check(
    'rehire: holiday pay from the ended version',
    await page.getByLabel('Holiday pay').isChecked(),
  );
  await next();
  check(
    'rehire: whole package pre-ticked',
    (await page.locator('input[type=checkbox]:checked').count()) === 3,
  );
  await next();
  check('rehire access: no portal login', await seen(page.getByText('No portal login')));
  check(
    'rehire access: email prefilled from the worker',
    (await val('#cv-email')) === REHIRE_EMAIL,
  );
  check(
    'rehire access: send line says the login will be created',
    await page.getByText(`Send creates their portal login at ${REHIRE_EMAIL}`).isVisible(),
  );
  await next();
  check(
    'rehire review: countersign waits for the package',
    await page.getByText('Countersign waits until the whole package is signed.').isVisible(),
  );
  await page.screenshot({ path: `${OUT}/shot-wizard-rehire-review.png`, fullPage: true });
  await page.keyboard.press('Escape');
} catch (err) {
  check('script ran without error', false, String(err));
  await page.screenshot({ path: `${OUT}/shot-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await setLoginEmail(MARIA_EMAIL).catch((e) => console.log(`teardown: ${e.message}`));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed.`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
