/**
 * Current team queue — the pure half (docs/CONTRACT-VERSIONS-PLAN.md §7.4).
 *
 * One active contractor → the things still owed on their contract or their
 * documents. No DB, no React; `fetchCurrentTeam` (src/db/queries/onboarding.ts)
 * feeds it and the Onboarding page renders it one row per contractor. Each item
 * also carries the contractor-facing `owed` lines the Remind email lists.
 */

import type { Database } from '@/db/types';
import { daysUntil } from '@/lib/documents/expiry';
import { humanizeKind, type RequiredDoc } from '@/lib/onboarding/documents';

export type OpenItemKind =
  | 'draft'
  | 'sent'
  | 'signed'
  | 'no_agreement'
  | 'doc_review'
  | 'doc_replacement'
  | 'doc_deferred'
  | 'doc_requested'
  | 'doc_expired'
  | 'doc_expiring';

export interface OpenItem {
  kind: OpenItemKind;
  label: string;
  tone: 'warn' | 'bad' | 'neutral';
  /** What the CONTRACTOR still has to do, one line each; empty when the ball is on the admin's side. */
  owed: string[];
}

export interface TeamDoc {
  id: string;
  kind: string;
  side: string | null;
  title?: string | null;
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
  /** Admin-requested documents (`onboarding_progress.extra_documents`). */
  requested?: readonly Pick<RequiredDoc, 'kind' | 'title'>[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const docLabel = (d: TeamDoc): string =>
  `${d.title || humanizeKind(d.kind)}${d.side ? ` (${d.side})` : ''}`;

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
    items.push({ kind: 'draft', label: 'Contract drafted, not sent', tone: 'neutral', owed: [] });
  else if (v?.status === 'sent') {
    const days = v.sentAt ? -daysUntil(v.sentAt.slice(0, 10), todayDate) : null;
    items.push({
      kind: 'sent',
      label: days == null ? 'Contract sent' : `Contract sent · ${plural(days, 'day')}`,
      tone: 'warn',
      owed: ['Sign your updated contractor agreement in the portal'],
    });
  } else if (v?.status === 'signed')
    items.push({ kind: 'signed', label: 'Signed, awaiting countersign', tone: 'warn', owed: [] });
  else if (!v && !input.hasIcSignature)
    items.push({ kind: 'no_agreement', label: 'No IC agreement in app', tone: 'warn', owed: [] });

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
  const replacement: string[] = [];
  const deferredDue: string[] = [];
  for (const d of latest.values()) {
    if (d.reviewStatus === 'pending') review += 1;
    else if (d.reviewStatus === 'needs_replacement') replacement.push(`Re-upload: ${docLabel(d)}`);
    else if (d.reviewStatus === 'deferred' && (!d.deferUntil || d.deferUntil <= today))
      deferredDue.push(`Upload: ${docLabel(d)}`);
  }
  if (review > 0)
    items.push({
      kind: 'doc_review',
      label: `${plural(review, 'document')} to review`,
      tone: 'neutral',
      owed: [],
    });
  if (replacement.length > 0)
    items.push({
      kind: 'doc_replacement',
      label: `${plural(replacement.length, 'replacement')} owed`,
      tone: 'warn',
      owed: replacement,
    });
  if (deferredDue.length > 0)
    items.push({
      kind: 'doc_deferred',
      label: `${plural(deferredDue.length, 'deferred document')} due`,
      tone: 'warn',
      owed: deferredDue,
    });

  // A requested document is outstanding until SOMETHING is uploaded for its
  // kind; after that the review states above take over.
  const uploadedKinds = new Set(input.docs.map((d) => d.kind));
  const requested = (input.requested ?? [])
    .filter((r) => !uploadedKinds.has(r.kind))
    .map((r) => `Upload: ${r.title}`);
  if (requested.length > 0)
    items.push({
      kind: 'doc_requested',
      label: `${plural(requested.length, 'requested document')} outstanding`,
      tone: 'warn',
      owed: requested,
    });

  const expired: string[] = [];
  const expiring: string[] = [];
  let soonest = Number.POSITIVE_INFINITY;
  for (const d of input.docs) {
    if (!d.storagePath || !d.expiresOn) continue;
    const days = daysUntil(d.expiresOn, todayDate);
    if (days < 0) expired.push(`Renew: ${docLabel(d)} (expired ${d.expiresOn})`);
    else if (days <= expiringWithinDays) {
      expiring.push(`Renew: ${docLabel(d)} (expires ${d.expiresOn})`);
      soonest = Math.min(soonest, days);
    }
  }
  if (expired.length > 0)
    items.push({
      kind: 'doc_expired',
      label: `${plural(expired.length, 'document')} expired`,
      tone: 'bad',
      owed: expired,
    });
  if (expiring.length > 0)
    items.push({
      kind: 'doc_expiring',
      label:
        expiring.length === 1
          ? `Document expires in ${plural(soonest, 'day')}`
          : `${expiring.length} documents expiring, first in ${plural(soonest, 'day')}`,
      tone: 'warn',
      owed: expiring,
    });

  return items;
};

/** Everything the contractor still has to do, across all items — the Remind email body. */
export const owedLines = (items: readonly OpenItem[]): string[] => items.flatMap((i) => i.owed);

/**
 * What the admin digest chases (plan §7 decision 6): contracts awaiting the
 * contractor's signature or the admin's countersign, and requested documents
 * nobody has uploaded. Review and expiry items already have their own digests.
 */
export const digestLines = (items: readonly OpenItem[]): string[] =>
  items.flatMap((i) =>
    i.kind === 'sent' || i.kind === 'signed' ? [i.label] : i.kind === 'doc_requested' ? i.owed : [],
  );
