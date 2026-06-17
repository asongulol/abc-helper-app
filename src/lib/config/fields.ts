/**
 * Configuration constants — PURE (no `server-only`, no DOM) so both the admin
 * Configuration panels and the contractor portal can import them.
 *
 *  - EDITABLE_FIELDS: the canonical list of profile fields an admin may expose
 *    for contractor self-edit (Configuration → "Portal — editable fields",
 *    screenshot manifest 25). The `key`s MUST match the field keys the portal
 *    profile editor checks (`src/components/portal/PortalProfile.tsx`) and the
 *    columns `updateOwnProfile` writes — extras live in `workers.profile_extras`.
 *  - MERGE_FIELDS: the agreement-template merge tokens (manifest 26). Tokens
 *    MUST match `src/lib/agreements/merge.ts` exactly.
 *  - AGREEMENT_KINDS: the four template tabs (manifest 26), verbatim labels.
 */

/** A profile field the admin can toggle as contractor-editable. */
export interface EditableFieldDef {
  /** Storage key — a `workers` column, or a `profile_extras` key when `extra`. */
  key: string;
  /** Admin-facing label (verbatim from manifest 25). */
  label: string;
  /** Stored in `workers.profile_extras` (jsonb) rather than a worker column. */
  extra?: boolean;
}

/**
 * The 28 portal-editable fields, in manifest-25 order. Payout DESTINATION (Wise
 * recipient id/UUID) is intentionally absent — it is always admin-only.
 */
export const EDITABLE_FIELDS: readonly EditableFieldDef[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'middle_name', label: 'Middle name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'ph_address', label: 'PH address' },
  { key: 'date_of_birth', label: 'Date of birth' },
  { key: 'gcash', label: 'GCash' },
  { key: 'paymaya', label: 'PayMaya' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'wise_tag', label: 'Wise Tag' },
  { key: 'emergency_name', label: 'Emergency contact name' },
  { key: 'emergency_relationship', label: 'Emergency relationship' },
  { key: 'emergency_mobile', label: 'Emergency mobile' },
  { key: 'permanent_address', label: 'Permanent address' },
  { key: 'address_landmark', label: 'Landmark' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'marital_status', label: 'Marital status' },
  { key: 'education_level', label: 'Highest Degree Attained' },
  { key: 'course', label: 'Degree and Major' },
  { key: 'year_graduated', label: 'Year graduated' },
  { key: 'school', label: 'School' },
  { key: 'nickname', label: 'Nickname', extra: true },
  { key: 'favorite_color', label: 'Favorite color', extra: true },
  { key: 'favorite_food', label: 'Favorite food', extra: true },
  { key: 'tshirt_size', label: 'T-shirt size', extra: true },
  { key: 'shoe_size', label: 'Shoe size', extra: true },
  { key: 'hobbies', label: 'Hobbies', extra: true },
  { key: 'motto', label: 'Personal motto', extra: true },
] as const;

/** Set of valid editable-field keys (for validating a saved selection). */
export const EDITABLE_FIELD_KEYS: ReadonlySet<string> = new Set(EDITABLE_FIELDS.map((f) => f.key));

/** An agreement-template merge token (manifest 26). */
export interface MergeFieldDef {
  /** Token name without braces, e.g. `contractor_name`. */
  token: string;
  /** Human description for the reference chip tooltip. */
  desc: string;
}

/** The 14 merge tokens accepted by `mergeAgreement`, for the reference chips. */
export const MERGE_FIELDS: readonly MergeFieldDef[] = [
  {
    token: 'employer_name',
    desc: 'The contracting employer (e.g. Aaron Anderson E.H.S. LLC)',
  },
  {
    token: 'client_name',
    desc: 'The assigned client company (alias of {{company_name}})',
  },
  { token: 'contractor_name', desc: "The contractor's full name" },
  {
    token: 'countersigner_name',
    desc: 'Who signs for Aaron Anderson E.H.S. LLC',
  },
  { token: 'position', desc: 'Position / role' },
  { token: 'rate', desc: 'Rate per period' },
  { token: 'monthly_rate', desc: 'Monthly rate (period × 2)' },
  { token: 'start_date', desc: 'Engagement start date' },
  { token: 'contractor_address', desc: "The contractor's address" },
  { token: 'employment_type', desc: 'e.g. "Full-time (40 hours/week)"' },
  { token: 'hours_per_week', desc: 'Expected hours per week' },
  { token: 'schedule', desc: 'Shift schedule' },
  { token: 'today', desc: "Today's date" },
  {
    token: 'addendum',
    desc: 'Scope-of-Work addendum (appended if not placed inline)',
  },
] as const;

/** The four agreement template kinds, verbatim tab labels (manifest 26). */
export const AGREEMENT_KINDS = [
  { kind: 'ic_agreement', label: 'IC Agreement' },
  { kind: 'non_compete', label: 'Non-Compete' },
  { kind: 'confidentiality_nda', label: 'NDA' },
  { kind: 'baa', label: 'BAA' },
] as const;

export type AgreementKind = (typeof AGREEMENT_KINDS)[number]['kind'];

/** Document-review reminder frequencies (manifest 27). */
export const REMINDER_FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays only' },
  { value: 'weekly', label: 'Weekly (Mondays)' },
] as const;

/** Signature-method choices per party (manifest 27). */
export const SIGNATURE_METHOD_CHOICES = [
  { value: 'both', label: 'Typed or drawn' },
  { value: 'typed', label: 'Typed only' },
  { value: 'drawn', label: 'Drawn only' },
] as const;
