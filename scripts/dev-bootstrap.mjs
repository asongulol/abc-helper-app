#!/usr/bin/env node
/**
 * Local dev bootstrap (LOCAL Supabase stack only — never prod).
 *
 * Creates an owner admin auth user + admin_users row so you can sign into the
 * app, then applies supabase/seed.sql demo data (companies, contractors, rates,
 * a period of approved time). Safe to re-run: it upserts.
 *
 * Usage:  pnpm dev:bootstrap
 *   Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.local.
 *   Refuses to run against a non-local URL.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Plain REST against GoTrue + PostgREST (no @supabase/supabase-js — it pulls in
// Realtime, which needs a WebSocket polyfill on Node < 22).

const ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL ?? 'owner@abckidsny.com';
const ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'devpassword123';

const loadEnv = () => {
  const env = {};
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    throw new Error('.env.local not found — run `supabase start` and wire env first.');
  }
  return env;
};

const main = async () => {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new Error('Missing Supabase env in .env.local.');
  if (!/(127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`Refusing to bootstrap a non-local Supabase URL: ${url}`);
  }

  const authHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const j = async (res) => {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  };

  // 1. Owner auth user (idempotent: look up, else create) via GoTrue admin REST.
  let userId;
  const listRes = await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers: authHeaders });
  const list = await j(listRes);
  const existing = (list?.users ?? []).find(
    (u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
  );
  if (existing) {
    userId = existing.id;
    process.stderr.write(`[bootstrap] owner auth user exists: ${ADMIN_EMAIL}\n`);
  } else {
    const createRes = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,
      }),
    });
    const created = await j(createRes);
    if (!createRes.ok) throw new Error(`createUser: ${JSON.stringify(created)}`);
    userId = created.id;
    process.stderr.write(`[bootstrap] created owner auth user: ${ADMIN_EMAIL}\n`);
  }

  // 2. admin_users owner row (idempotent upsert) via PostgREST.
  const upsertRes = await fetch(`${url}/rest/v1/admin_users?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...authHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: userId,
      email: ADMIN_EMAIL.toLowerCase(),
      role: 'owner',
      can_countersign: true,
    }),
  });
  if (!upsertRes.ok) throw new Error(`admin_users upsert: ${JSON.stringify(await j(upsertRes))}`);

  // 3. Demo data from seed.sql — pipe through the local stack's Postgres
  // container (works across Supabase CLI versions).
  execSync(
    'docker exec -i "$(docker ps --filter name=supabase_db -q | head -1)" ' +
      'psql -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/seed.sql',
    { stdio: 'inherit', shell: '/bin/bash' },
  );

  process.stderr.write(
    `\n[bootstrap] done.\n  Sign in at /login as ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}\n`,
  );
};

main().catch((err) => {
  process.stderr.write(`[bootstrap] FAILED: ${err.message}\n`);
  process.exit(1);
});
