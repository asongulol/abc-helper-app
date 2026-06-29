/**
 * Classify a draft-transfer-create failure (legacy parity, wise-payouts/index.ts).
 *
 * Wise returns 422/403 when the "recipient" is actually a Wisetag/balance
 * contact that isn't bank-fundable (the Lea-style case). Surface that as the
 * actionable `wisetag_unsupported` reason instead of an opaque status dump; any
 * other error keeps its raw text (prefixed). The error string is whatever
 * wiseRequest throws: "Wise API POST /v1/transfers → <status>: <body>".
 *
 * ponytail: regex mirrors the legacy classifier; draft-time only (no money
 * moves), so a false positive merely relabels an already-failed draft.
 */
export function classifyDraftError(prefix: string, e: unknown): string {
  const s = String(e);
  const isRecipientReject =
    /→ (?:422|403):/.test(s) && /target.?account|recipient|not.*(?:bank|active)|balance/i.test(s);
  return isRecipientReject ? 'wisetag_unsupported' : prefix + s;
}
