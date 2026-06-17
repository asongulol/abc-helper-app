/**
 * Pure required-document checklist derivation — side-effect-free and DB-free so
 * it runs in Server Components, Server Actions, and unit tests alike.
 *
 * Single source of truth for "which required documents does a contractor still
 * owe, and what is the state of each". Used by:
 *   - the contractor portal (outstanding-but-missing slots to upload), and
 *   - the admin onboarding review (full checklist incl. MISSING docs), which
 *     previously only listed uploaded docs and gave no hint of what was missing
 *     when a contractor stalled in Stage 3.
 */

import type { Database } from '@/db/types';

export type ReviewStatus = Database['public']['Enums']['review_status'];
/** A required slot's state: a review_status, or 'missing' when nothing is uploaded. */
export type DocSlotState = ReviewStatus | 'missing';

/** A configured required document (structurally compatible with OnbDocument). */
export interface RequiredDoc {
  kind: string;
  title: string;
  required?: boolean;
  /** e.g. ['front','back'] for a two-sided doc → one slot per side. */
  sides?: string[];
  /** Months until the doc expires (NBI = 6). */
  freshness_months?: number;
}

/** The minimal uploaded-document shape the checklist needs. */
export interface UploadedDocLike {
  id: string;
  kind: string;
  side: string | null;
  reviewStatus: string;
  /** ISO timestamp; when present the latest upload per slot is chosen by it. */
  createdAt?: string | null;
}

/** One required document slot, resolved against the contractor's uploads. */
export interface DocSlotStatus {
  kind: string;
  side: string | null;
  label: string;
  freshnessMonths: number | null;
  /** Latest uploaded document id for this slot, or null when none. */
  documentId: string | null;
  /** Latest upload's review status, or 'missing'. */
  state: DocSlotState;
  /** True when a document has been uploaded for this slot. */
  uploaded: boolean;
  /** True when the contractor still owes action (missing / needs_replacement / deferred). */
  outstanding: boolean;
}

/** Legacy DEFAULT_DOCS (portal/index.html ~1113) — used when config has none. */
export const DEFAULT_REQUIRED_DOCS: readonly RequiredDoc[] = [
  { kind: 'resume', title: 'Resume / CV', required: true },
  {
    kind: 'diploma',
    title: 'Diploma or Transcript of Records',
    required: true,
  },
  {
    kind: 'nbi_clearance',
    title: 'NBI Clearance',
    required: true,
    freshness_months: 6,
  },
  {
    kind: 'gov_id',
    title: 'Government-issued ID or Passport',
    required: true,
    sides: ['front', 'back'],
  },
];

/** Latest-upload statuses that still require contractor action (portal parity). */
const ACTION_STATUSES = new Set<string>(['needs_replacement', 'deferred']);

/**
 * Expand each REQUIRED configured doc into per-side slots and resolve each
 * against the contractor's uploads (latest per kind|side wins). Falls back to
 * DEFAULT_REQUIRED_DOCS when no documents are configured.
 */
export function deriveDocChecklist(
  configuredDocs: readonly RequiredDoc[],
  uploaded: readonly UploadedDocLike[],
): DocSlotStatus[] {
  const docs = configuredDocs.length > 0 ? configuredDocs : DEFAULT_REQUIRED_DOCS;

  // Latest upload per kind|side. Sort newest-first; tie-break on id so the choice
  // is TOTAL and never depends on the caller's query ordering (admin reads
  // created_at ascending, portal descending) even when two rows share a timestamp.
  const sorted = [...uploaded].sort(
    (a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
      String(b.id).localeCompare(String(a.id)),
  );
  const latestByKey = new Map<string, UploadedDocLike>();
  for (const d of sorted) {
    const key = `${d.kind}|${d.side ?? ''}`;
    if (!latestByKey.has(key)) latestByKey.set(key, d);
  }

  const slots: DocSlotStatus[] = [];
  for (const d of docs) {
    if (d.required === false) continue;
    const freshnessMonths = d.freshness_months ?? null;
    const sides = Array.isArray(d.sides) && d.sides.length > 0 ? d.sides : [null];
    for (const side of sides) {
      const latest = latestByKey.get(`${d.kind}|${side ?? ''}`);
      slots.push({
        kind: d.kind,
        side,
        label: side ? `${d.title} (${side})` : d.title,
        freshnessMonths,
        documentId: latest?.id ?? null,
        state: (latest?.reviewStatus as ReviewStatus | undefined) ?? 'missing',
        uploaded: !!latest,
        outstanding: !latest || ACTION_STATUSES.has(latest.reviewStatus),
      });
    }
  }

  // Legacy parity with the contractor portal's useOutstandingDocs (legacy
  // portal/index.html ~1121-1128): also surface any uploaded doc that was sent
  // back (needs_replacement) or deferred whose kind|side is NOT a configured
  // required slot — e.g. an optional doc, or an 'other'/'w8ben' upload an admin
  // rejected. Without this the contractor gets no re-upload prompt and the
  // rejected doc is silently orphaned.
  const requiredKeys = new Set(slots.map((s) => `${s.kind}|${s.side ?? ''}`));
  for (const [key, d] of latestByKey) {
    if (requiredKeys.has(key) || !ACTION_STATUSES.has(d.reviewStatus)) continue;
    slots.push({
      kind: d.kind,
      side: d.side,
      label: humanizeKind(d.kind),
      freshnessMonths: null,
      documentId: d.id,
      state: d.reviewStatus as DocSlotState,
      uploaded: true,
      outstanding: true,
    });
  }
  return slots;
}

/** Human-readable fallback label for a doc kind that has no configured title. */
function humanizeKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Required slots the contractor still owes (missing or needing re-upload). */
export function outstandingSlots(slots: readonly DocSlotStatus[]): DocSlotStatus[] {
  return slots.filter((s) => s.outstanding);
}

/** A document row as needed to evaluate stage-3 completion (raw DB shape). */
export interface Stage3DocRow {
  id: string;
  kind: string;
  side: string | null;
  storage_path?: string | null;
  review_status: string;
}

/** A required stage-3 document (single, or two-sided like gov_id). */
export interface RequiredStage3Doc {
  kind: string;
  sides?: readonly string[];
}

/** The required stage-3 documents — single source of truth for completion. */
export const REQUIRED_STAGE3_DOCS: readonly RequiredStage3Doc[] = [
  { kind: 'resume' },
  { kind: 'diploma' },
  { kind: 'nbi_clearance' },
  { kind: 'gov_id', sides: ['front', 'back'] },
];

/**
 * Whether stage-3 (documents) is complete: each required kind is either CLEARED
 * by a waived/deferred decision, or has an approved upload (both sides for a
 * two-sided kind). Shared by the contractor self-complete (finishOnboarding) and
 * the admin review recompute (recomputeStage3) so they can never diverge on the
 * waived/deferred rule. `rows` should already be filtered to satisfying statuses
 * (approved/waived/deferred).
 */
export function isStage3Complete(
  rows: readonly Stage3DocRow[],
  required: readonly RequiredStage3Doc[] = REQUIRED_STAGE3_DOCS,
): boolean {
  const evidence: Record<string, Set<string>> = {};
  const sidesSeen: Record<string, Set<string>> = {};
  const cleared: Record<string, boolean> = {};
  for (const r of rows) {
    if (r.review_status === 'waived' || r.review_status === 'deferred') {
      cleared[r.kind] = true;
      continue;
    }
    if (!evidence[r.kind]) evidence[r.kind] = new Set();
    (evidence[r.kind] as Set<string>).add(r.storage_path ?? r.id);
    if (r.side) {
      if (!sidesSeen[r.kind]) sidesSeen[r.kind] = new Set();
      (sidesSeen[r.kind] as Set<string>).add(r.side);
    }
  }
  return required.every((d) => {
    if (cleared[d.kind]) return true;
    if (d.sides && d.sides.length > 0) {
      const have = sidesSeen[d.kind] ?? new Set<string>();
      return d.sides.every((s) => have.has(s));
    }
    return (evidence[d.kind]?.size ?? 0) >= 1;
  });
}
