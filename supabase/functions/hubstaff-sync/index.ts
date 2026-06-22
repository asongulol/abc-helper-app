// Supabase Edge Function: hubstaff-sync (Deno thin wrapper)
// ---------------------------------------------------------------------------
// ARCHITECTURE NOTE — SINGLE SOURCE OF TRUTH
// ---------------------------------------------------------------------------
// The pure transform logic is defined in src/lib/hubstaff/transform.ts in the
// Next.js app. This file is a thin Deno wrapper that:
//   1. Authenticates the incoming request (x-cron-secret for cron; admin bearer
//      for the manual sync_ingest action).
//   2. Exchanges / rotates the Hubstaff refresh token (same api_tokens table).
//   3. Pulls activities and PTO from the Hubstaff API using the same endpoints.
//   4. Calls the pure transform functions (vendored / copy below — Deno cannot
//      import from the Next.js src/ tree at runtime).
//   5. Upserts time_entries via the Supabase REST API (fetch-only, no Node SDK).
//
// TODO: once Deno supports importing from local TS paths that resolve across
// mono-repo boundaries (or the project migrates to a shared npm package for the
// pure lib), replace the vendored transform below with an import of
// src/lib/hubstaff/transform.ts directly. Until then, keep the vendored copy
// in sync manually — the pure functions have zero runtime deps (no fetch, no env)
// so drift is easy to detect (unit tests cover them independently).
//
// CRON SCHEDULE: stays here. The 'Sync now' button in the Next.js UI calls
// src/server/actions/hubstaff.ts → src/server/hubstaff/service.ts instead.
//
// Deploy:
//   supabase functions deploy hubstaff-sync
//   supabase secrets set HUBSTAFF_REFRESH_TOKEN="..."
//   supabase secrets set CRON_SECRET="..."  # shared with app env
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://account.hubstaff.com/access_tokens';
const API = 'https://api.hubstaff.com/v2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const tokHdr = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Employer resolution ───────────────────────────────────────────────────────
// Contractors are attributed to the single employer company (companies.kind =
// 'employer'); clients are billing tags. Derive it from the data, never a magic
// UUID — env override (EMPLOYER_COMPANY_ID) wins only as an explicit escape hatch.

async function getEmployerCompanyId(): Promise<string> {
  const override = Deno.env.get('EMPLOYER_COMPANY_ID');
  if (override) return override.trim();
  const r = await fetch(
    `${SB_URL}/rest/v1/companies?kind=eq.employer&select=id&order=created_at.asc&limit=1`,
    { headers: tokHdr },
  );
  if (r.ok) {
    const rows = await r.json();
    const id = rows?.[0]?.id;
    if (id) return String(id);
  }
  throw new Error(
    "no employer company found (companies.kind='employer'); create one or set EMPLOYER_COMPANY_ID",
  );
}

// ── Token management ──────────────────────────────────────────────────────────

async function getStored(): Promise<Record<string, string> | null> {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/api_tokens?provider=eq.hubstaff&select=refresh_token,access_token,access_expires_at`,
      { headers: tokHdr },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function saveTokens(fields: Record<string, string>): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/api_tokens`, {
    method: 'POST',
    headers: { ...tokHdr, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ provider: 'hubstaff', updated_at: new Date().toISOString(), ...fields }),
  }).catch(() => undefined);
}

async function getAccessToken(): Promise<string> {
  const row = await getStored();
  if (row?.access_token && row.access_expires_at) {
    const msLeft = new Date(row.access_expires_at).getTime() - Date.now();
    if (msLeft > 5 * 60_000) return row.access_token;
  }
  const refresh = row?.refresh_token ?? Deno.env.get('HUBSTAFF_REFRESH_TOKEN');
  if (!refresh) throw new Error('no Hubstaff refresh token (set HUBSTAFF_REFRESH_TOKEN)');

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${await r.text()}`);
  const data = await r.json();
  const expiresIn = Number(data.expires_in ?? 3600);
  await saveTokens({
    refresh_token: data.refresh_token ?? refresh,
    access_token: data.access_token,
    access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  return data.access_token;
}

// ── Pagination ────────────────────────────────────────────────────────────────

async function pageAll<T>(url: string, token: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let pageStart: string | null = null;
  for (let i = 0; i < 50; i++) {
    const u = new URL(url);
    if (pageStart) u.searchParams.set('page_start_id', pageStart);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${key} fetch failed (${r.status}): ${await r.text()}`);
    const data = await r.json();
    for (const row of data[key] ?? []) out.push(row as T);
    pageStart = data?.pagination?.next_page_start_id ?? null;
    if (!pageStart) break;
  }
  return out;
}

// ── Pure transform (vendored from src/lib/hubstaff/transform.ts) ──────────────
// TODO: replace with a shared npm package or Deno import once infra supports it.

function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = String(raw)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[.,]/g, ' ')
    .replace(/\bMa\b/gi, 'Maria')
    .replace(/\b(jr|sr|ii|iii|iv|n)\b/gi, ' ');
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}
const nameKey = (raw: string | null | undefined): string => {
  const t = nameTokens(raw);
  return t.length ? [...t].sort().join(' ') : '';
};
const looseKey = (raw: string | null | undefined): string => {
  const t = nameTokens(raw);
  if (!t.length) return '';
  if (t.length === 1) return t[0] ?? '';
  return `${t[0]} ${t[t.length - 1]}`;
};

// ── Cron ingest handler ───────────────────────────────────────────────────────

async function handleCronIngest(body: Record<string, unknown>): Promise<Response> {
  const orgId = Number(body.org_id);
  if (!Number.isFinite(orgId) || orgId <= 0) return json({ error: 'need org_id' }, 400);
  const companyId = body.company_id
    ? String(body.company_id).trim()
    : await getEmployerCompanyId();

  // Resolve window.
  const lookback = Math.max(0, Math.min(31, Number(body.lookback_days ?? 3)));
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today ?? ''))
    ? String(body.today)
    : new Date().toISOString().slice(0, 10);
  const stopMs = new Date(`${today}T23:59:59Z`).getTime();
  const startMs = new Date(`${today}T00:00:00Z`).getTime() - lookback * 86_400_000;
  const start = new Date(startMs).toISOString().slice(0, 10);
  const stop = today;

  const token = await getAccessToken();

  // Member names.
  const members = await pageAll<{ user_id?: number; id?: number }>(
    `${API}/organizations/${orgId}/members`,
    token,
    'members',
  );
  const userIds = [
    ...new Set(members.map((m) => m.user_id ?? m.id).filter((id): id is number => id != null)),
  ];
  const nameById = new Map<number, string>();
  for (let i = 0; i < userIds.length; i += 50) {
    const qs = userIds
      .slice(i, i + 50)
      .map((id) => `id%5B%5D=${id}`)
      .join('&');
    const r = await fetch(`${API}/users?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const data = await r.json();
    for (const u of data.users ?? []) nameById.set(u.id, u.name ?? `user ${u.id}`);
  }
  for (const id of userIds.filter((id) => !nameById.has(id))) {
    const r = await fetch(`${API}/users/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const d = await r.json();
    const u = d.user ?? d;
    nameById.set(id, u?.name ?? `user ${id}`);
  }
  for (const id of userIds) if (!nameById.has(id)) nameById.set(id, `user ${id}`);

  // Activities.
  const acts = await pageAll<{ user_id: number; date: string; tracked: number; overall: number }>(
    `${API}/organizations/${orgId}/activities/daily?date%5Bstart%5D=${start}&date%5Bstop%5D=${stop}`,
    token,
    'daily_activities',
  );

  // Accumulate.
  const trackedDay = new Map<number, Map<string, number>>();
  const overallDay = new Map<number, Map<string, number>>();
  for (const a of acts) {
    const uid = a.user_id;
    const day = a.date;
    if (!uid || !day) continue;
    let tm = trackedDay.get(uid);
    if (!tm) {
      tm = new Map();
      trackedDay.set(uid, tm);
    }
    let om = overallDay.get(uid);
    if (!om) {
      om = new Map();
      overallDay.set(uid, om);
    }
    tm.set(day, (tm.get(day) ?? 0) + (a.tracked ?? 0));
    om.set(day, (om.get(day) ?? 0) + (a.overall ?? 0));
  }

  // PTO.
  const ptoDay = new Map<number, Map<string, number>>();
  try {
    const ptoReqs = await pageAll<{
      user_id: number;
      status: string;
      time_off_request_days: Array<{ date: string; amount_used: number }>;
    }>(`${API}/organizations/${orgId}/time_off_requests`, token, 'time_off_requests');
    for (const req of ptoReqs) {
      if (req.status !== 'approved') continue;
      for (const d of req.time_off_request_days ?? []) {
        const date = d.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const dMs = new Date(`${date}T00:00:00Z`).getTime();
        if (dMs < startMs || dMs > stopMs) continue;
        const secs = Number(d.amount_used ?? 0);
        if (!Number.isFinite(secs) || secs <= 0) continue;
        let pm = ptoDay.get(req.user_id);
        if (!pm) {
          pm = new Map();
          ptoDay.set(req.user_id, pm);
        }
        pm.set(date, (pm.get(date) ?? 0) + secs);
      }
    }
  } catch {
    /* PTO optional */
  }

  // Worker match index (employer-wide).
  const wcRes = await fetch(
    `${SB_URL}/rest/v1/worker_companies?select=company_id,worker_id,hubstaff_name,hubstaff_user_id,status,workers(first_name,last_name,status)`,
    { headers: tokHdr },
  );
  const links: Array<Record<string, unknown>> = wcRes.ok ? await wcRes.json() : [];
  const byId = new Map<number, string>();
  const byStrict = new Map<string, string>();
  const byLoose = new Map<string, string>();
  for (const l of links) {
    const wid = String(l.worker_id ?? '');
    if (!wid) continue;
    if (l.hubstaff_user_id != null && !byId.has(Number(l.hubstaff_user_id))) {
      byId.set(Number(l.hubstaff_user_id), wid);
    }
    const realName =
      `${(l.workers as Record<string, string> | null)?.first_name ?? ''} ${(l.workers as Record<string, string> | null)?.last_name ?? ''}`.trim();
    for (const src of [l.hubstaff_name as string | null, realName].filter(Boolean) as string[]) {
      const sk = nameKey(src);
      const lk = looseKey(src);
      if (sk && !byStrict.has(sk)) byStrict.set(sk, wid);
      if (lk && !byLoose.has(lk)) byLoose.set(lk, wid);
    }
  }
  const matchWorker = (uid: number, nm: string): string | null =>
    byId.get(uid) ?? byStrict.get(nameKey(nm)) ?? byLoose.get(looseKey(nm)) ?? null;

  // Days in window.
  const days: string[] = [];
  for (let t = startMs; t <= stopMs; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }

  // Canonical source_name.
  const allWorkerIds = [...new Set(links.map((l) => String(l.worker_id ?? '')).filter(Boolean))];
  const canonical = new Map<string, string>();
  if (allWorkerIds.length) {
    const inList = allWorkerIds.map((w) => `"${w}"`).join(',');
    const cRes = await fetch(
      `${SB_URL}/rest/v1/time_entries?company_id=eq.${companyId}&worker_id=in.(${inList})&select=company_id,worker_id,source_name,work_date&order=work_date.desc`,
      { headers: tokHdr },
    );
    if (cRes.ok)
      for (const row of await cRes.json()) {
        const k = `${row.company_id}|${row.worker_id}`;
        if (row.worker_id && !canonical.has(k)) canonical.set(k, row.source_name);
      }
  }

  // Decided guard. Also capture stored seconds so we can detect divergence (F3)
  // when a decided day's Hubstaff numbers change after a human decision.
  const exRes = await fetch(
    `${SB_URL}/rest/v1/time_entries?company_id=eq.${companyId}&work_date=gte.${start}&work_date=lte.${stop}&select=company_id,worker_id,source_name,work_date,approval,tracked_seconds,pto_seconds`,
    { headers: tokHdr },
  );
  const decidedBySrc = new Set<string>();
  const decidedByWorker = new Set<string>();
  const decidedValues = new Map<string, { tracked: number; pto: number }>();
  if (exRes.ok)
    for (const row of await exRes.json()) {
      if (row.approval && row.approval !== 'pending') {
        const srcKey = `${row.company_id}|${row.source_name}|${row.work_date}`;
        decidedBySrc.add(srcKey);
        const vals = {
          tracked: Number(row.tracked_seconds ?? 0),
          pto: Number(row.pto_seconds ?? 0),
        };
        decidedValues.set(srcKey, vals);
        if (row.worker_id) {
          const workerKey = `${row.company_id}|${row.worker_id}|${row.work_date}`;
          decidedByWorker.add(workerKey);
          decidedValues.set(workerKey, vals);
        }
      }
    }

  // Build rows (pure transform logic mirrored from src/lib/hubstaff/transform.ts).
  const unmatched = new Set<string>();
  const rows: unknown[] = [];
  const importBatchId = crypto.randomUUID();
  const idsToPersist: Array<{ company_id: string; worker_id: string; uid: number }> = [];
  const divergences: Array<{
    worker_id: string;
    source_name: string;
    work_date: string;
    stored_tracked: number;
    stored_pto: number;
    incoming_tracked: number;
    incoming_pto: number;
  }> = [];

  for (const uid of userIds) {
    const nm = nameById.get(uid) ?? `user ${uid}`;
    const wId = matchWorker(uid, nm);
    if (!wId) {
      if (trackedDay.has(uid) || ptoDay.has(uid)) unmatched.add(nm);
      continue;
    }
    const co = companyId;
    const src = canonical.get(`${co}|${wId}`) ?? nm;
    const link = links.find((l) => l.worker_id === wId && l.company_id === co);
    if (uid != null && link && link.hubstaff_user_id == null) {
      idsToPersist.push({ company_id: co, worker_id: wId, uid });
    }
    for (const day of days) {
      const tracked = trackedDay.get(uid)?.get(day) ?? 0;
      const pto = ptoDay.get(uid)?.get(day) ?? 0;
      if (tracked === 0 && pto === 0) continue;
      const srcKey = `${co}|${src}|${day}`;
      const workerKey = `${co}|${wId}|${day}`;
      if (decidedBySrc.has(srcKey) || decidedByWorker.has(workerKey)) {
        // F3: decided day — never overwrite, but surface a divergence if the
        // freshly-pulled seconds differ from the frozen stored value.
        const stored = decidedValues.get(srcKey) ?? decidedValues.get(workerKey);
        if (stored && (stored.tracked !== tracked || stored.pto !== pto)) {
          divergences.push({
            worker_id: wId,
            source_name: src,
            work_date: day,
            stored_tracked: stored.tracked,
            stored_pto: stored.pto,
            incoming_tracked: tracked,
            incoming_pto: pto,
          });
        }
        continue;
      }
      const overall = overallDay.get(uid)?.get(day) ?? 0;
      const activityPct = tracked > 0 ? Math.round((overall / tracked) * 100) : null;
      rows.push({
        company_id: co,
        worker_id: wId,
        source_name: src,
        work_date: day,
        tracked_seconds: tracked,
        pto_seconds: pto,
        activity_pct: activityPct,
        approval: 'pending',
        import_batch_id: importBatchId,
      });
    }
  }

  // Upsert.
  let written = 0;
  if (rows.length) {
    const up = await fetch(
      `${SB_URL}/rest/v1/time_entries?on_conflict=company_id,source_name,work_date`,
      {
        method: 'POST',
        headers: { ...tokHdr, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      },
    );
    if (!up.ok) return json({ error: `upsert failed (${up.status}): ${await up.text()}` }, 500);
    written = rows.length;
  }

  // Persist stable ids.
  for (const p of idsToPersist) {
    await fetch(
      `${SB_URL}/rest/v1/worker_companies?company_id=eq.${p.company_id}&worker_id=eq.${p.worker_id}&hubstaff_user_id=is.null`,
      {
        method: 'PATCH',
        headers: { ...tokHdr, Prefer: 'return=minimal' },
        body: JSON.stringify({ hubstaff_user_id: p.uid }),
      },
    ).catch(() => undefined);
  }

  // F3: audit-log decided-day divergences (best-effort) so they aren't silent.
  if (divergences.length) {
    await fetch(`${SB_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...tokHdr, Prefer: 'return=minimal' },
      body: JSON.stringify({
        company_id: companyId,
        action: 'time_divergence',
        entity: companyId,
        detail: { count: divergences.length, window: { start, stop }, items: divergences.slice(0, 100) },
      }),
    }).catch(() => undefined);
  }

  return json({
    ok: true,
    window: { start, stop },
    company_id: companyId,
    members_seen: userIds.length,
    rows_written: written,
    ids_persisted: idsToPersist.length,
    divergences,
    unmatched: [...unmatched],
    import_batch_id: importBatchId,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Auth.
    const action = String(body.action ?? 'cron_ingest');
    const provided = req.headers.get('x-cron-secret') ?? String(body.secret ?? '');
    const sRes = await fetch(`${SB_URL}/rest/v1/app_secrets?key=eq.cron_secret&select=value`, {
      headers: tokHdr,
    });
    const expected = sRes.ok ? (await sRes.json())?.[0]?.value : null;
    if (!expected || provided !== expected) return json({ error: 'unauthorized' }, 401);

    if (action === 'cron_ingest') return handleCronIngest(body);

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
