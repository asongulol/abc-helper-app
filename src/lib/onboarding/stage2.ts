/**
 * Stage 2 (profile) completion — PURE. The contractor never "marks" a section
 * complete; each section ticks itself off from the saved profile row. These
 * rules were the old complete_tab validation, unchanged: Payout passes with
 * ANY one method filled.
 */

import { EDITABLE_FIELDS } from '@/lib/config/fields';

export const STAGE2_SECTIONS = [
  { key: 'contact', label: 'Contact' },
  { key: 'personal', label: 'Personal info' },
  { key: 'payout', label: 'Payout method' },
] as const;
export type Stage2Section = (typeof STAGE2_SECTIONS)[number]['key'];

const REQUIRED: Record<Stage2Section, readonly string[]> = {
  contact: ['first_name', 'last_name', 'ph_address', 'mobile', 'date_of_birth'],
  personal: ['emergency_name', 'emergency_relationship', 'emergency_mobile', 'marital_status'],
  payout: [],
};
export const PAYOUT_METHODS = ['gcash', 'paymaya', 'paypal', 'wise_tag'] as const;
export const PAYOUT_ANY_LABEL = 'at least one payout method (GCash, PayMaya, PayPal or Wise Tag)';

/** Columns `stage2Missing` reads — select exactly these. */
export const STAGE2_COLUMNS = [...REQUIRED.contact, ...REQUIRED.personal, ...PAYOUT_METHODS].join(
  ', ',
);

/** Missing-field LABELS per section; a section is done when its list is empty. */
export type Stage2Missing = Record<Stage2Section, string[]>;

const filled = (v: unknown) => v != null && String(v).trim() !== '';
const label = (k: string) => EDITABLE_FIELDS.find((f) => f.key === k)?.label ?? k;

export function stage2Missing(w: Record<string, unknown> | null | undefined): Stage2Missing {
  const miss = (keys: readonly string[]) => keys.filter((k) => !filled(w?.[k])).map(label);
  return {
    contact: miss(REQUIRED.contact),
    personal: miss(REQUIRED.personal),
    payout: PAYOUT_METHODS.some((k) => filled(w?.[k])) ? [] : [PAYOUT_ANY_LABEL],
  };
}

export const isStage2Complete = (m: Stage2Missing) =>
  STAGE2_SECTIONS.every((s) => m[s.key].length === 0);

/** "Contact still needs: Mobile." — null when everything is filled. */
export function stage2Summary(m: Stage2Missing): string | null {
  const parts = STAGE2_SECTIONS.filter((s) => m[s.key].length).map(
    (s) => `${s.label} still needs: ${m[s.key].join(', ')}`,
  );
  return parts.length ? `${parts.join('. ')}.` : null;
}
