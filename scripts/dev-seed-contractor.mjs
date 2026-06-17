#!/usr/bin/env node
/**
 * Local dev: give a seeded worker a contractor-portal login (LOCAL Supabase only).
 *
 * Creates a GoTrue auth user, links it to an existing `workers` row via
 * `contractor_logins`, and marks `onboarding_progress` complete so the login lands
 * straight in the full portal (not the onboarding gate). Idempotent; re-runnable.
 *
 * Usage:  node scripts/dev-seed-contractor.mjs
 *   Env overrides: DEV_CONTRACTOR_WORKER_ID, DEV_CONTRACTOR_EMAIL, DEV_CONTRACTOR_PASSWORD
 */

import { readFileSync } from 'node:fs';

const WORKER_ID = process.env.DEV_CONTRACTOR_WORKER_ID ?? 'a0000000-0000-0000-0000-000000000001';
const EMAIL = (process.env.DEV_CONTRACTOR_EMAIL ?? 'maria@abckidsny.com').toLowerCase();
const PASSWORD = process.env.DEV_CONTRACTOR_PASSWORD ?? 'devpassword123';

const loadEnv = () => {
  const env = {};
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
};

const main = async () => {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env in .env.local.');
  if (!/(127\.0\.0\.1|localhost)/.test(url)) throw new Error(`Refusing non-local URL: ${url}`);

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const j = async (res) => {
    const t = await res.text();
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return t;
    }
  };

  // 1. Auth user (find or create).
  let userId;
  const list = await j(await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers }));
  const existing = (list?.users ?? []).find((u) => u.email?.toLowerCase() === EMAIL);
  if (existing) {
    userId = existing.id;
  } else {
    const created = await j(
      await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: EMAIL,
          password: PASSWORD,
          email_confirm: true,
        }),
      }),
    );
    if (!created?.id) throw new Error(`createUser: ${JSON.stringify(created)}`);
    userId = created.id;
  }

  // 2. contractor_logins (upsert on worker_id).
  const loginRes = await fetch(`${url}/rest/v1/contractor_logins?on_conflict=worker_id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      worker_id: WORKER_ID,
      auth_user_id: userId,
      email: EMAIL,
      status: 'active',
    }),
  });
  if (!loginRes.ok) throw new Error(`contractor_logins: ${JSON.stringify(await j(loginRes))}`);

  // 3. onboarding_progress complete (upsert on worker_id) → lands in the full portal.
  const now = new Date().toISOString();
  const opRes = await fetch(`${url}/rest/v1/onboarding_progress?on_conflict=worker_id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      worker_id: WORKER_ID,
      current_stage: 'complete',
      stage1_complete: true,
      stage2_complete: true,
      stage3_complete: true,
      started_at: now,
      completed_at: now,
      updated_at: now,
    }),
  });
  if (!opRes.ok) throw new Error(`onboarding_progress: ${JSON.stringify(await j(opRes))}`);

  process.stderr.write(
    `\n[seed-contractor] done.\n  Sign in at /portal/login as ${EMAIL} / ${PASSWORD}\n  (worker ${WORKER_ID}, onboarding marked complete)\n`,
  );
};

main().catch((err) => {
  process.stderr.write(`[seed-contractor] FAILED: ${err.message}\n`);
  process.exit(1);
});
