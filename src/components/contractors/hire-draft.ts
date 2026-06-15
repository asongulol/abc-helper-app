'use client';

import { useEffect, useRef } from 'react';

/**
 * localStorage-backed draft for the Add Contractor wizard. A half-finished hire
 * survives a refresh/close/navigation; nothing touches the DB until "Create
 * contractor". The draft is keyed per-company so two companies can have separate
 * in-flight hires. Faithful port of the legacy `eis_hire_draft_<companyId>` flow.
 */

const KEY_PREFIX = 'eis_hire_draft_';

export interface HireDraft<F> {
  f: F;
  step: number;
  companyName?: string;
  at: number;
}

const draftKey = (companyId: string): string => `${KEY_PREFIX}${companyId || 'none'}`;

/** Persist the current draft immediately (used on guarded close + autosave). */
export function draftSave<F>(companyId: string, draft: HireDraft<F>): void {
  try {
    localStorage.setItem(draftKey(companyId), JSON.stringify(draft));
  } catch {
    /* storage unavailable / quota — drafting is best-effort */
  }
}

/** Load a saved draft, or null if none / unparsable / missing the form payload. */
export function draftLoad<F>(companyId: string): HireDraft<F> | null {
  try {
    const raw = localStorage.getItem(draftKey(companyId));
    if (!raw) return null;
    const d = JSON.parse(raw) as HireDraft<F> | null;
    return d && typeof d.f === 'object' && d.f != null ? d : null;
  } catch {
    return null;
  }
}

/** Remove a saved draft (on create or "Start fresh"). */
export function draftClear(companyId: string): void {
  try {
    localStorage.removeItem(draftKey(companyId));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Debounced autosave hook (500 ms). Writes the draft whenever `value` changes and
 * `hasContent` is true; once `done` (via the returned `markDone`) it stops writing
 * — so a created hire never re-persists. Returns `markDone` to call after a
 * successful create.
 */
export function useAutoDraft<F>(
  companyId: string,
  value: HireDraft<F>,
  hasContent: boolean,
): { markDone: () => void } {
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current || !hasContent) return;
    const id = setTimeout(() => {
      if (doneRef.current) return;
      draftSave(companyId, { ...value, at: Date.now() });
    }, 500);
    return () => clearTimeout(id);
    // value is the snapshot to persist; companyId/hasContent gate it.
  }, [companyId, value, hasContent]);

  return {
    markDone: () => {
      doneRef.current = true;
      draftClear(companyId);
    },
  };
}
