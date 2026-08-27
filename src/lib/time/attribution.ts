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
  /** worker_companies.contract (FT/PT/PH/PS/PHS) — drives expected hours. */
  contract?: string | null;
}

export interface MatchHit {
  workerId: string;
  isInactive: boolean;
  /** Two different workers share this key — see the collision note below. */
  ambiguous?: boolean;
}

export interface MatchIndex {
  byName: Map<string, MatchHit>;
  byLoose: Map<string, MatchHit>;
}

/**
 * Index one key. First write wins, but a SECOND worker landing on the same key
 * marks it ambiguous instead: "Maria A. Santos" and "Maria L. Santos" both
 * loose-key to "maria santos", so first-wins would quietly pay one of them for
 * the other's hours. The entry object is per-key, so flagging one collision
 * never poisons this worker's other (unique) keys.
 */
const put = (map: Map<string, MatchHit>, key: string, workerId: string, isInactive: boolean) => {
  if (!key) return;
  const prior = map.get(key);
  if (!prior) map.set(key, { workerId, isInactive });
  else if (prior.workerId !== workerId) prior.ambiguous = true;
};

/** Build a two-tier name-match index from the company roster. */
export const buildMatchIndex = (links: readonly RosterLink[]): MatchIndex => {
  const byName = new Map<string, MatchHit>();
  const byLoose = new Map<string, MatchHit>();

  for (const l of links) {
    // Index hubstaff name + real name (first+last) + full name (with middle), so a
    // source name matches whether or not it carries the middle. nameKey is sorted,
    // so the with-middle key is distinct; looseKey (first+last) covers either way.
    const realName = [l.firstName, l.lastName].filter(Boolean).join(' ');
    const fullName = [l.firstName, l.middleName, l.lastName].filter(Boolean).join(' ');
    const sources = [l.hubstaffName, realName, fullName].filter(Boolean) as string[];

    for (const src of sources) {
      put(byName, nameKey(src), l.workerId, l.isInactive);
      put(byLoose, looseKey(src), l.workerId, l.isInactive);
    }
  }

  return { byName, byLoose };
};

/** Resolve a raw source name to a worker, or null if unmatched OR ambiguous.
 *  Strict key wins over loose key (same priority as legacy). An ambiguous key
 *  resolves to nothing on purpose — guessing decides who gets paid. */
export const matchName = (rawName: string, idx: MatchIndex): MatchHit | null => {
  const strict = idx.byName.get(nameKey(rawName));
  // A shared strict key means the loose key is shared too — don't fall through.
  if (strict) return strict.ambiguous ? null : strict;
  const loose = idx.byLoose.get(looseKey(rawName));
  return loose && !loose.ambiguous ? loose : null;
};

export type AttributionStatus = 'matched' | 'inactive' | 'unmatched' | 'ambiguous';

/** Return the attribution status for a given source name. */
export const attributionStatus = (rawName: string, idx: MatchIndex): AttributionStatus => {
  const hit = matchName(rawName, idx);
  if (hit) return hit.isInactive ? 'inactive' : 'matched';
  const shared = idx.byName.get(nameKey(rawName)) ?? idx.byLoose.get(looseKey(rawName));
  return shared?.ambiguous ? 'ambiguous' : 'unmatched';
};
