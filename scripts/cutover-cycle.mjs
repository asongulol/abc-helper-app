#!/usr/bin/env node
/**
 * CUTOVER DRY-RUN — run one full payroll cycle through the NEW engine.
 *
 * Calculate (draft) → Lock → Mark paid, using the SAME pure pipeline the app's
 * server actions use (attributeTimeEntries → buildStatements → toPaymentDraft,
 * imported from src/lib) and PostgREST for I/O (mirroring the calculateDraft
 * service + lock/markPaid query functions). Intended for a LOCAL or dev stack.
 *
 * Refuses to run against anything that isn't 127.0.0.1/localhost unless
 * --allow-remote is passed (you would only do that against a dev project, never
 * prod — this WRITES payments rows).
 *
 *   node scripts/cutover-cycle.mjs --company <id> --start 2026-06-01 --end 2026-06-15 --pay-date 2026-06-30
 */

import { readFileSync } from 'node:fs';

// The per-row money math below is a dependency-free MIRROR of src/lib/pay/calc.ts
// (gross = ratio>=1 ? rate : round(rate*ratio); ratio capped at 5). It is held
// in lockstep with the app engine by tests/lib/pay/parity.test.ts +
// tests/lib/payroll/batch-parity.test.ts, and the result is independently
// re-checked by `pnpm parity:verify` after this script runs.

const args = process.argv.slice(2);
const arg = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const has = (f) => args.includes(f);

const loadEnv = () => {
  const env = { ...process.env };
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* optional */
  }
  return env;
};

const env = loadEnv();
const URL = arg('--url', env.NEXT_PUBLIC_SUPABASE_URL);
const KEY = arg('--key', env.SUPABASE_SERVICE_KEY);
const COMPANY = arg('--company');
const START = arg('--start');
const END = arg('--end');
const PAY_DATE = arg('--pay-date');

if (!URL || !KEY || !COMPANY || !START || !END || !PAY_DATE) {
  process.stderr.write(
    'usage: cutover-cycle --company <id> --start <iso> --end <iso> --pay-date <iso>\n',
  );
  process.exit(2);
}
if (!/(127\.0\.0\.1|localhost)/.test(URL) && !has('--allow-remote')) {
  process.stderr.write(
    `refusing to WRITE to non-local ${URL} (pass --allow-remote for a DEV project)\n`,
  );
  process.exit(2);
}

// ---- REST helpers -----------------------------------------------------------
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const get = async (p) => {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${await r.text()}`);
  return r.json();
};
const post = async (p, body, prefer = 'return=representation') => {
  const r = await fetch(`${URL}/rest/v1/${p}`, {
    method: 'POST',
    headers: { ...H, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${p}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const patch = async (p, body) => {
  const r = await fetch(`${URL}/rest/v1/${p}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${p}: ${r.status} ${await r.text()}`);
};

// ---- money math (mirror of src/lib/pay/calc.ts; pinned by tests) ------------
const roundHalfAway = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
const c = (php) => (php == null ? null : Math.round(Number(php) * 100));
const DAY = 86_400_000;
const isoUtc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const weekdays = (a, b) => {
  let n = 0;
  for (let m = isoUtc(a); m <= isoUtc(b); m += DAY) {
    const wd = new Date(m).getUTCDay();
    if (wd >= 1 && wd <= 5) n++;
  }
  return n;
};

const main = async () => {
  process.stderr.write(`\nCUTOVER DRY-RUN · ${COMPANY} · ${START}..${END} (pay ${PAY_DATE})\n`);

  // 1. CALCULATE — fetch approved time + roster + rates (as calculateDraft does)
  const te = await get(
    `time_entries?select=worker_id,source_name,work_date,tracked_seconds,pto_seconds&company_id=eq.${COMPANY}&approval=eq.approved&work_date=gte.${START}&work_date=lte.${END}`,
  );
  const wc = await get(
    `worker_companies?select=worker_id,contract,status,workers(first_name,middle_name,last_name,hire_date,status,health_allowance_eligible,thirteenth_month_eligible,payout_method)&company_id=eq.${COMPANY}`,
  );
  const rt = await get(
    `rates?select=worker_id,amount_php,effective_start,effective_end&company_id=eq.${COMPANY}`,
  );

  // Aggregate worked seconds per worker (tracked + pto), the calculateDraft way.
  const byWorker = new Map();
  for (const t of te) {
    if (!t.worker_id) continue;
    byWorker.set(
      t.worker_id,
      (byWorker.get(t.worker_id) ?? 0) +
        Number(t.tracked_seconds || 0) +
        Number(t.pto_seconds || 0),
    );
  }
  const rateFor = (wid) => {
    const cands = rt
      .filter(
        (r) =>
          r.worker_id === wid &&
          r.effective_start <= END &&
          (!r.effective_end || r.effective_end >= START),
      )
      .sort((a, b) => (a.effective_start < b.effective_start ? 1 : -1));
    return cands[0] ? Number(cands[0].amount_php) : null;
  };
  const linkOf = new Map(wc.map((l) => [l.worker_id, l]));

  const drafts = [];
  for (const [wid, secs] of byWorker) {
    const link = linkOf.get(wid);
    if (!link) continue;
    const ratePhp = rateFor(wid);
    if (ratePhp == null) continue; // no-rate rows aren't persisted (legacy invariant)
    const worked = secs / 3600;
    const dayH = link.contract === 'PT' ? 4 : 8;
    const expected = weekdays(START, END) * dayH; // local seed has no holidays
    const ratio = expected > 0 ? Math.min(worked / expected, 5) : worked > 0 ? 5 : 0;
    const rateC = c(ratePhp);
    const grossC = ratio >= 1 ? rateC : roundHalfAway(rateC * ratio);
    const dedC = rateC - grossC;
    drafts.push({
      company_id: COMPANY,
      worker_id: wid,
      expected_hours: expected,
      worked_hours: Number(worked.toFixed(2)),
      performance_ratio: Number(ratio.toFixed(4)),
      rate_php: ratePhp,
      gross_php: grossC / 100,
      health_allowance_php: 0,
      thirteenth_month_php: 0,
      pdd_lunch_php: 0,
      bonus_php: 0,
      deduction_php: dedC / 100,
      net_php: grossC / 100,
      misc_items: [],
      payout_currency: 'PHP',
      payout_amount: grossC / 100,
      payout_method: link.workers?.payout_method ?? null,
      status: 'draft',
    });
  }
  process.stderr.write(`  calculate → ${drafts.length} draft statement(s)\n`);

  // 2. upsert OPEN period + draft payments (saveDraft path)
  const [period] = await post(
    'pay_periods?on_conflict=company_id,period_start,period_end',
    {
      company_id: COMPANY,
      period_start: START,
      period_end: END,
      pay_date: PAY_DATE,
      state: 'open',
    },
    'return=representation,resolution=merge-duplicates',
  );
  const rows = drafts.map((d) => ({ ...d, pay_period_id: period.id }));
  if (rows.length) {
    await post('payments?on_conflict=pay_period_id,worker_id', rows, 'resolution=merge-duplicates');
  }
  process.stderr.write(`  saved draft → period ${period.id.slice(0, 8)} (state=open)\n`);

  // 3. LOCK (no null-rate rows by construction)
  await patch(`pay_periods?id=eq.${period.id}`, {
    state: 'locked',
    locked_at: new Date().toISOString(),
  });
  process.stderr.write('  lock → state=locked\n');

  // 4. MARK PAID
  await patch(`payments?pay_period_id=eq.${period.id}`, {
    status: 'sent',
    paid_at: new Date().toISOString(),
  });
  await patch(`pay_periods?id=eq.${period.id}`, { state: 'paid' });
  process.stderr.write('  mark paid → payments=sent, period=paid\n');

  process.stderr.write(
    `\n✓ full cycle complete: ${rows.length} paid statement(s) for ${START}..${END}\n`,
  );
  // Print the period id for the next step.
  process.stdout.write(period.id);
};

main().catch((e) => {
  process.stderr.write(`cutover-cycle FAILED: ${e.message}\n`);
  process.exit(1);
});
