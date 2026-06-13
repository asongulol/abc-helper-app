/**
 * Pure date-normalisation helpers for Wise API responses.
 *
 * Wise sometimes returns space-separated "YYYY-MM-DD HH:MM:SS" (UTC), sometimes
 * ISO 8601 with a T separator. Both are normalised to a real ISO string or null.
 *
 * No server-only imports — safe to use in pure lib code and tests.
 */

import type { WiseDates, WiseTransfer } from './types';

/** Normalise a Wise timestamp to an ISO string, or null if unparseable. */
export function toIsoWise(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Derive the created/dateFunded/dateSent triple from a FULL transfer detail
 * object (GET /v1/transfers/{id}). Pure — no network.
 */
export function wiseDatesFromRow(row: Record<string, unknown>): WiseDates {
  return {
    created: toIsoWise(row.created ?? row.createdAt),
    dateFunded: toIsoWise(row.dateFunded ?? row.fundedDate ?? null),
    dateSent: toIsoWise(row.dateSent ?? row.sentDate ?? null),
  };
}

/**
 * Best-effort WiseDates from a list-endpoint transfer row (only `created` is
 * reliably present; dateFunded/dateSent require the detail endpoint).
 */
export function wiseDatesFromListRow(t: WiseTransfer): WiseDates {
  return {
    created: toIsoWise(t.created ?? t.createdAt),
    dateFunded: null,
    dateSent: null,
  };
}

/** Pick the "best" sent timestamp from a WiseDates triple (precedence: dateSent > dateFunded > created). */
export function bestSentDate(dates: WiseDates): string | null {
  return dates.dateSent ?? dates.dateFunded ?? dates.created ?? null;
}
