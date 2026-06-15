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
  { kind: 'diploma', title: 'Diploma or Transcript of Records', required: true },
  { kind: 'nbi_clearance', title: 'NBI Clearance', required: true, freshness_months: 6 },
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

  // Latest upload per kind|side. Sort newest-first when timestamps are present
  // so the choice doesn't depend on the caller's query ordering (admin reads
  // ascending, portal descending).
  const sorted = [...uploaded].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
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
  return slots;
}

/** Required slots the contractor still owes (missing or needing re-upload). */
export function outstandingSlots(slots: readonly DocSlotStatus[]): DocSlotStatus[] {
  return slots.filter((s) => s.outstanding);
}
