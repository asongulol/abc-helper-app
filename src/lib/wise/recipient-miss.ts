/**
 * When a Wise recipient id resolves to "missing" (a 404, or a 403
 * RECIPIENT_MISSING), the cause is one of two very different things. We tell
 * them apart by how many recipients the current token/profile can actually see,
 * and return an admin-facing explanation.
 *
 *  - count <= 0 → the token/profile sees NO recipients at all, so NO id would
 *    resolve. That's a credential/environment problem (e.g. a sandbox token
 *    pointed at production data, or the wrong Wise profile), not stale data.
 *  - count  > 0 → the profile has recipients; this id simply isn't one of them.
 *    It was deleted or re-created in Wise. Re-linking the contractor fixes it.
 *
 * Pure on purpose: the network probe (the recipient count) is fetched by the
 * caller, so this branch logic stays trivially testable.
 */
export function missingRecipientReason(recipientId: number, recipientCount: number): string {
  if (recipientCount <= 0) {
    return (
      'Wise returned 0 recipients for this profile — the WISE_API_TOKEN likely targets the wrong ' +
      'Wise account or environment (e.g. sandbox vs production), so no recipient id will resolve. ' +
      'Verify the token/profile before re-linking.'
    );
  }
  return (
    `Recipient ${recipientId} is not among the ${recipientCount} recipient(s) on this Wise ` +
    'profile — it was probably deleted or re-created in Wise. Re-link the contractor’s payout recipient.'
  );
}
