/**
 * Pure name-matching helpers for attributing time-import rows to workers.
 *
 * Mirrors the legacy indexLinks + matchExisting functions
 * (abc-work-app-payroll-wis-hubstaff-app/app/index.html ~4526–4551).
 *
 * No I/O; takes pre-fetched roster rows as input.
 */

import { looseKey, nameKey } from '@/lib/names';

export interface RosterLink {
  workerId: string;
  hubstaffName: string | null;
  /** worker real name for fallback matching */
  firstName: string | null;
  lastName: string | null;
  /** Optional middle name — indexed so a source name WITH a middle still strict-matches. */
  middleName?: string | null;
  isInactive: boolean;
}

export interface MatchIndex {
  byName: Map<string, { workerId: string; isInactive: boolean }>;
  byLoose: Map<string, { workerId: string; isInactive: boolean }>;
}

/** Build a two-tier name-match index from the company roster. */
export const buildMatchIndex = (links: readonly RosterLink[]): MatchIndex => {
  const byName = new Map<string, { workerId: string; isInactive: boolean }>();
  const byLoose = new Map<string, { workerId: string; isInactive: boolean }>();

  for (const l of links) {
    const val = { workerId: l.workerId, isInactive: l.isInactive };

    // Index hubstaff name + real name (first+last) + full name (with middle), so a
    // source name matches whether or not it carries the middle. nameKey is sorted,
    // so the with-middle key is distinct; looseKey (first+last) covers either way.
    const realName = [l.firstName, l.lastName].filter(Boolean).join(' ');
    const fullName = [l.firstName, l.middleName, l.lastName].filter(Boolean).join(' ');
    const sources = [l.hubstaffName, realName, fullName].filter(Boolean) as string[];

    for (const src of sources) {
      const sk = nameKey(src);
      const lk = looseKey(src);
      if (sk && !byName.has(sk)) byName.set(sk, val);
      if (lk && !byLoose.has(lk)) byLoose.set(lk, val);
    }
  }

  return { byName, byLoose };
};

/** Resolve a raw source name to a worker, or null if unmatched.
 *  Strict key wins over loose key (same priority as legacy). */
export const matchName = (
  rawName: string,
  idx: MatchIndex,
): { workerId: string; isInactive: boolean } | null => {
  const sk = nameKey(rawName);
  const lk = looseKey(rawName);
  return idx.byName.get(sk) ?? idx.byLoose.get(lk) ?? null;
};

export type AttributionStatus = 'matched' | 'inactive' | 'unmatched';

/** Return the attribution status for a given source name. */
export const attributionStatus = (rawName: string, idx: MatchIndex): AttributionStatus => {
  const hit = matchName(rawName, idx);
  if (!hit) return 'unmatched';
  if (hit.isInactive) return 'inactive';
  return 'matched';
};
