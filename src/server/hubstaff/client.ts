import 'server-only';

/**
 * Thin authenticated HTTP client for the Hubstaff API.
 *
 * Server-only: the refresh token and access token NEVER leave the server bundle.
 * Env vars are lazy-validated at call time so the app boots without them.
 *
 * TOKEN ROTATION: Hubstaff rotates the refresh token on every exchange.
 * The new token is persisted to the api_tokens table via the service client
 * (same pattern as the legacy edge fn). Access tokens are cached and only
 * refreshed when ≤5 min of lifetime remains.
 *
 * RATE-LIMIT GUARD: we must NOT exchange the refresh token on every request.
 * The access token is valid ~24-72 h; re-use it until near-expiry.
 */

import { createServiceClient } from '@/db/clients/service';
import { env } from '@/server/env';

const TOKEN_URL = 'https://account.hubstaff.com/access_tokens';
export const HUBSTAFF_API_BASE = 'https://api.hubstaff.com/v2';

// ─── env lazy-validation ──────────────────────────────────────────────────────

function getRefreshToken(): string {
  const t = env.HUBSTAFF_REFRESH_TOKEN;
  if (!t) {
    throw new Error(
      'HUBSTAFF_REFRESH_TOKEN is not set. Add it to your .env.local (server-only — never NEXT_PUBLIC_).',
    );
  }
  return t;
}

// ─── Stored token (api_tokens table) ─────────────────────────────────────────

interface StoredToken {
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: string | null;
}

async function getStored(): Promise<StoredToken | null> {
  try {
    const db = createServiceClient();
    const { data } = await db
      .from('api_tokens')
      .select('refresh_token,access_token,access_expires_at')
      .eq('provider', 'hubstaff')
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

async function saveTokens(fields: {
  refresh_token: string;
  access_token: string;
  access_expires_at: string;
}): Promise<void> {
  try {
    const db = createServiceClient();
    await db.from('api_tokens').upsert(
      {
        provider: 'hubstaff',
        updated_at: new Date().toISOString(),
        ...fields,
      },
      { onConflict: 'provider' },
    );
  } catch {
    // best-effort — a failed persist just means we refresh again next call
  }
}

// ─── Token exchange ────────────────────────────────────────────────────────────

/**
 * Return a valid access token. Reads the cached token from api_tokens and only
 * exchanges the refresh token when the access token is missing or expiring.
 */
export async function getAccessToken(): Promise<string> {
  const row = await getStored();

  // Reuse cached access token if still valid (>5 min life left).
  if (row?.access_token && row.access_expires_at) {
    const msLeft = new Date(row.access_expires_at).getTime() - Date.now();
    if (msLeft > 5 * 60_000) return row.access_token;
  }

  // Exchange the refresh token for a new access token.
  const refresh = row?.refresh_token ?? getRefreshToken();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
    }),
  });
  if (!res.ok) {
    throw new Error(`Hubstaff token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresIn = Number(data.expires_in ?? 3600);
  await saveTokens({
    refresh_token: data.refresh_token ?? refresh,
    access_token: data.access_token,
    access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });

  return data.access_token;
}

// ─── Pagination helper ─────────────────────────────────────────────────────────

/**
 * Fetch all pages from a Hubstaff endpoint that supports cursor pagination.
 * Extracts the array at `key` from each page and appends to the output list.
 * Safety cap: 50 pages (~5000 rows).
 *
 * @param url   Full URL (params already encoded).
 * @param token Valid access token.
 * @param key   JSON key for the array in the response body.
 */
export async function pageAll<T = unknown>(url: string, token: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let pageStart: string | null = null;

  for (let i = 0; i < 50; i++) {
    const u = new URL(url);
    if (pageStart) u.searchParams.set('page_start_id', pageStart);

    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Hubstaff ${key} fetch failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const items = data[key];
    if (Array.isArray(items)) {
      for (const item of items) out.push(item as T);
    }

    const pagination = data.pagination as Record<string, unknown> | null | undefined;
    pageStart = (pagination?.next_page_start_id as string | null | undefined) ?? null;
    if (!pageStart) break;
  }

  return out;
}

// ─── Projects ──────────────────────────────────────────────────────────────────

/** A Hubstaff project (subset used by the Configuration mapping panel). */
export interface HubstaffProject {
  id: number;
  name: string;
}

/**
 * Fetch all projects for a Hubstaff organization (cursor-paginated).
 * Thin wrapper over `pageAll`; the caller upserts these into `hubstaff_projects`.
 */
export async function fetchHubstaffProjects(
  orgId: number,
  token: string,
): Promise<HubstaffProject[]> {
  const raw = await pageAll<{ id?: number; name?: string | null }>(
    `${HUBSTAFF_API_BASE}/organizations/${orgId}/projects`,
    token,
    'projects',
  );
  return raw
    .filter((p): p is { id: number; name?: string | null } => p.id != null)
    .map((p) => ({ id: p.id, name: p.name ?? `project ${p.id}` }));
}

// ─── Member/user name resolution ──────────────────────────────────────────────

/**
 * Resolve a Hubstaff org's member user_ids to display names.
 *
 * Strategy:
 *   1. Bulk GET /v2/users?id[]=… (chunks of 50).
 *   2. Per-user GET /v2/users/{id} fallback for any still unnamed.
 *
 * Returns a Map<userId, displayName>.
 */
export async function fetchMemberNames(orgId: number, token: string): Promise<Map<number, string>> {
  // 1. Fetch org members to get user ids.
  const members = await pageAll<{ user_id?: number; id?: number }>(
    `${HUBSTAFF_API_BASE}/organizations/${orgId}/members`,
    token,
    'members',
  );
  const userIds = [
    ...new Set(members.map((m) => m.user_id ?? m.id).filter((id): id is number => id != null)),
  ];

  const nameById = new Map<number, string>();

  // 2. Bulk resolve (chunks of 50 to stay under URL length limits).
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const qs = chunk.map((id) => `id%5B%5D=${id}`).join('&');
    try {
      const res = await fetch(`${HUBSTAFF_API_BASE}/users?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = (await res.json()) as {
        users?: Array<{ id: number; name?: string | null }>;
      };
      for (const u of data.users ?? []) {
        nameById.set(u.id, u.name ?? `user ${u.id}`);
      }
    } catch {
      break;
    }
  }

  // 3. Individual fallback for any still unnamed.
  for (const id of userIds.filter((id) => !nameById.has(id))) {
    try {
      const res = await fetch(`${HUBSTAFF_API_BASE}/users/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        user?: { name?: string | null };
        name?: string | null;
      };
      const u = data.user ?? data;
      nameById.set(id, (u as { name?: string | null }).name ?? `user ${id}`);
    } catch {
      // skip
    }
  }

  // Fallback names for any user_id still missing.
  for (const id of userIds) {
    if (!nameById.has(id)) nameById.set(id, `user ${id}`);
  }

  return nameById;
}
