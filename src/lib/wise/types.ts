/**
 * Pure types for the Wise matcher (src/lib/wise/matcher.ts).
 * No server-only imports — safe to import in tests.
 */

/** A single Wise transfer as returned by GET /v1/transfers. */
export interface WiseTransfer {
  id: number;
  status: string;
  targetAccount: number | string | null | undefined;
  /** UUID-shaped recipient id (future Wise API format). */
  recipientId?: string | null;
  targetValue?: number | null;
  targetAmount?: number | null;
  created?: string | null;
  createdAt?: string | null;
}

/** A Wise date triple derived from a full transfer detail object. */
export interface WiseDates {
  created: string | null;
  dateFunded: string | null;
  dateSent: string | null;
}

/** Worker recipient fields joined onto a payment row for the matcher. */
export interface WorkerRecipientInfo {
  wise_recipient_id?: number | null;
  wise_recipient_uuid?: string | null;
  /** JSON column — array of { id: number|string } objects. */
  wise_recipients?: unknown;
}

/** A payment row as consumed by the pure matcher. */
export interface MatcherPayment {
  id: string;
  worker_id: string;
  net_php: number | null;
  original_net_php: number | null;
  status: string;
  wise_transfer_id?: string | number | null;
  workers?: WorkerRecipientInfo | null;
  pay_periods?: {
    pay_date?: string | null;
    period_end?: string | null;
  } | null;
}

/** Terminal success states returned by Wise (mirrors legacy paidStates set). */
export const WISE_PAID_STATES = new Set(['outgoing_payment_sent', 'completed', 'sent']);

/** In-flight states (not terminal, not cancelled). */
export const WISE_IN_FLIGHT_STATES = new Set([
  'processing',
  'funds_converted',
  'incoming_payment_waiting',
  'waiting_recipient_input_to_proceed',
]);

// ---- match outcome strings ----------------------------------------

export type MatchOutcome =
  | 'no_recipient'
  | 'no_wise_transfer'
  | 'no_wise_transfer_in_window'
  | 'ambiguous_exact'
  | 'matched_exact'
  | 'matched_closest_date'
  | 'matched_with_variance_overridden'
  | 'matched_with_variance'
  | 'db_write_failed'
  | 'refreshed_clean'
  | 'refresh_transfer_not_in_history';

export interface MatchResultBase {
  payment_id: string;
  worker_id: string;
  outcome: MatchOutcome;
}

export interface MatchResultNoRecipient extends MatchResultBase {
  outcome: 'no_recipient';
  reason: string;
}

export interface MatchResultNoTransfer extends MatchResultBase {
  outcome: 'no_wise_transfer' | 'no_wise_transfer_in_window';
  reason: string;
  recipient_keys_tried?: string[];
  candidate_orphan_transfers?: OrphanCandidate[];
}

export interface MatchResultAmbiguous extends MatchResultBase {
  outcome: 'ambiguous_exact';
  reason: string;
  candidate_transfer_ids: string[];
}

export interface MatchResultSuccess extends MatchResultBase {
  outcome: 'matched_exact' | 'matched_closest_date' | 'refreshed_clean';
  transfer_id: string;
  amount: number;
  wise_status: string;
  wise_dates: WiseDates;
  also_considered?: string[];
}

export interface MatchResultVariance extends MatchResultBase {
  outcome: 'matched_with_variance_overridden' | 'matched_with_variance';
  transfer_id: string;
  db_amount: number;
  wise_amount: number;
  delta: number;
  wise_status: string;
  wise_dates: WiseDates;
  other_candidates?: number;
  amount_overridden: boolean;
}

export interface MatchResultDbFailed extends MatchResultBase {
  outcome: 'db_write_failed';
  error: string;
}

export interface MatchResultRefreshNotFound extends MatchResultBase {
  outcome: 'refresh_transfer_not_in_history';
  transfer_id: string;
  reason: string;
}

export type MatchResult =
  | MatchResultNoRecipient
  | MatchResultNoTransfer
  | MatchResultAmbiguous
  | MatchResultSuccess
  | MatchResultVariance
  | MatchResultDbFailed
  | MatchResultRefreshNotFound;

export interface OrphanCandidate {
  transfer_id: string;
  target_account: string;
  target_value: number;
  created: string | null;
  wise_status: string | null;
  shared_with_n_payments: number;
  ambiguous: boolean;
}

/** What the pure matcher returns for a single payment (no DB side-effects). */
export interface MatchDecision {
  /** The proposed DB patch to apply (undefined = no write needed). */
  patch?: PaymentPatch;
  result: MatchResult;
}

/**
 * The fields the matcher wants to write to a payments row.
 * The service layer turns this into a Supabase update call.
 */
export interface PaymentPatch {
  wise_transfer_id?: string;
  wise_dates?: WiseDates;
  original_net_php?: number;
  net_php?: number;
  paid_at?: string;
  status?: string;
  wise_locked_at?: string;
}
