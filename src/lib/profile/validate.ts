/**
 * Trust-boundary validation for contractor self-edited profile fields. The portal
 * form strips phone input to digits and could cap lengths client-side, but a
 * hand-crafted request can post anything — so the real checks live here, where
 * every save routes through `updateOwnProfile`. (#017 phone, #041 length)
 */

const PHONE_FIELDS = new Set(['mobile', 'emergency_mobile']);
export const MAX_FIELD_LEN = 200;

const FIELD_LABELS: Record<string, string> = {
  mobile: 'Mobile',
  emergency_mobile: 'Emergency contact mobile',
};

/** Plausible phone: 7–15 digits (E.164 range), ignoring +, spaces, dashes, parens. */
export const looksLikePhone = (v: string): boolean => {
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
};

/** Returns a user-facing error for the first invalid field, or null if all pass. */
export function validateProfileFields(fields: Record<string, string | null>): string | null {
  for (const [k, v] of Object.entries(fields)) {
    const val = typeof v === 'string' ? v.trim() : '';
    if (val === '') continue; // clearing a field is allowed
    if (val.length > MAX_FIELD_LEN)
      return `${FIELD_LABELS[k] ?? k} is too long (max ${MAX_FIELD_LEN} characters).`;
    if (PHONE_FIELDS.has(k) && !looksLikePhone(val))
      return `Enter a valid phone number for ${FIELD_LABELS[k] ?? k}.`;
  }
  return null;
}
