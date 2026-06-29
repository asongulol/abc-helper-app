import 'server-only';
import { env } from '@/server/env';

/**
 * Thin authenticated fetch wrapper over the Wise API.
 *
 * Server-only: the WISE_API_TOKEN never leaves the server bundle.
 * Base URL matches the legacy function — override with WISE_API_BASE
 * to point at the sandbox (https://api.sandbox.transferwise.tech).
 *
 * DRAFT-ONLY (ADR-0007): this client is intentionally missing any
 * helper that would call the funding endpoint. The guardrail scanner
 * (scripts/guardrails.mjs) enforces this at build time.
 */

const BASE = process.env.WISE_API_BASE ?? 'https://api.wise.com';

/** Lazy-validate the token; throws a clear error when missing. */
function getToken(): string {
  const token = env.WISE_API_TOKEN;
  if (!token) {
    throw new Error(
      'WISE_API_TOKEN is not set. Add it to your .env.local (server-only — never NEXT_PUBLIC_).',
    );
  }
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export interface WiseRequestInit {
  method?: string;
  body?: unknown;
}

/**
 * Authenticated fetch against the Wise API. Returns the parsed JSON body.
 * Throws on non-2xx responses with the status code + body text in the message.
 */
export async function wiseRequest<T = unknown>(path: string, init?: WiseRequestInit): Promise<T> {
  const token = getToken();
  const method = init?.method ?? 'GET';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(token),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable body)');
    throw new Error(`Wise API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Same as wiseRequest but returns null instead of throwing when the resource
 * is absent. Used for single-resource lookups (GET /v1/accounts/:id).
 *
 * "Absent" is two cases: a plain 404, and a 403 `RECIPIENT_MISSING` — Wise
 * returns the latter when a recipient id is no longer among yours (deleted in
 * Wise, or a stale/foreign id). For a single-resource lookup both mean the same
 * thing ("not found"), so both resolve to null. Any OTHER 403 (bad token or
 * insufficient scope) is a real auth failure and still throws.
 */
export async function wiseRequestNullable<T = unknown>(
  path: string,
  init?: WiseRequestInit,
): Promise<T | null> {
  const token = getToken();
  const method = init?.method ?? 'GET';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(token),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable body)');
    if (res.status === 403 && text.includes('RECIPIENT_MISSING')) return null;
    throw new Error(`Wise API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Expose the lazy-validate helper so service.ts can call it when needed. */
/** Wise API base URL (re-exported so tests can inspect without importing process.env). */
export { BASE as WISE_BASE, getToken };
