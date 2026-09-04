/**
 * Current team queue — the pure half (docs/CONTRACT-VERSIONS-PLAN.md §7.4).
 *
 * One active contractor → the things still owed on their contract or their
 * documents. No DB, no React; `fetchCurrentTeam` (src/db/queries/onboarding.ts)
 * feeds it and the Onboarding page renders it one row per contractor.
 */

import type { Database } from '@/db/types';
import { daysUntil } from '@/lib/documents/expiry';

export type OpenItemKind =
  | 'draft'
  | 'sent'
  | 'signed'
  | 'no_agreement'
  | 'doc_review'
  | 'doc_replacement'
  | 'doc_deferred'
  | 'doc_expired'
  | 'doc_expiring';

export interface OpenItem {
  kind: OpenItemKind;
  label: string;
  tone: 'warn' | 'bad' | 'neutral';
}

export interface TeamDoc {
  id: string;
  kind: string;
  side: string | null;
  reviewStatus: Database['public']['Enums']['review_status'];
  storagePath: string | null;
  expiresOn: string | null;
  deferUntil: string | null;
  createdAt: string;
}

export interface TeamInput {
  /** The engagement's in-flight version, else its active one, else null. */
  version: {
    status: Database['public']['Enums']['contract_version_status'];
    sentAt: string | null;
  } | null;
  /** A signed `ic_agreement` signature exists (the v1 read-through). */
  hasIcSignature: boolean;
  docs: readonly TeamDoc[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Open items for one contractor, as of `today` (ISO date). Review states are
 * judged on the LATEST upload per kind|side (same rule as deriveDocChecklist —
 * a re-upload retires the rejection it answered); expiry looks at every row
 * that has a file, mirroring the expiry digest.
 */
export const deriveOpenItems = (
  input: TeamInput,
  today: string,
  expiringWithinDays = 30,
): OpenItem[] => {
  const items: OpenItem[] = [];
  const todayDate = new Date(`${today}T00:00:00Z`);

  const v = input.version;
  if (v?.status === 'draft')
    items.push({ kind: 'draft', label: 'Contract drafted, not sent', tone: 'neutral' });
  else if (v?.status === 'sent') {
    const days = v.sentAt ? -daysUntil(v.sentAt.slice(0, 10), todayDate) : null;
    items.push({
      kind: 'sent',
      label: days == null ? 'Contract sent' : `Contract sent · ${plural(days, 'day')}`,
      tone: 'warn',
    });
  } else if (v?.status === 'signed')
    items.push({ kind: 'signed', label: 'Signed, awaiting countersign', tone: 'warn' });
  else if (!v && !input.hasIcSignature)
    items.push({ kind: 'no_agreement', label: 'No IC agreement in app', tone: 'warn' });

  // Latest per slot — newest first, id as the total tie-break.
  const sorted = [...input.docs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const latest = new Map<string, TeamDoc>();
  for (const d of sorted) {
    const key = `${d.kind}|${d.side ?? ''}`;
    if (!latest.has(key)) latest.set(key, d);
  }
  let review = 0;
  let replacement = 0;
  let deferredDue = 0;
  for (const d of latest.values()) {
    if (d.reviewStatus === 'pending') review += 1;
    else if (d.reviewStatus === 'needs_replacement') replacement += 1;
    else if (d.reviewStatus === 'deferred' && (!d.deferUntil || d.deferUntil <= today))
      deferredDue += 1;
  }
  if (review > 0)
    items.push({
      kind: 'doc_review',
      label: `${plural(review, 'document')} to review`,
      tone: 'neutral',
    });
  if (replacement > 0)
    items.push({
      kind: 'doc_replacement',
      label: `${plural(replacement, 'replacement')} owed`,
      tone: 'warn',
    });
  if (deferredDue > 0)
    items.push({
      kind: 'doc_deferred',
      label: `${plural(deferredDue, 'deferred document')} due`,
      tone: 'warn',
    });

  let expired = 0;
  let expiring = 0;
  let soonest = Number.POSITIVE_INFINITY;
  for (const d of input.docs) {
    if (!d.storagePath || !d.expiresOn) continue;
    const days = daysUntil(d.expiresOn, todayDate);
    if (days < 0) expired += 1;
    else if (days <= expiringWithinDays) {
      expiring += 1;
      soonest = Math.min(soonest, days);
    }
  }
  if (expired > 0)
    items.push({
      kind: 'doc_expired',
      label: `${plural(expired, 'document')} expired`,
      tone: 'bad',
    });
  if (expiring > 0)
    items.push({
      kind: 'doc_expiring',
      label:
        expiring === 1
          ? `Document expires in ${plural(soonest, 'day')}`
          : `${expiring} documents expiring, first in ${plural(soonest, 'day')}`,
      tone: 'warn',
    });

  return items;
};
