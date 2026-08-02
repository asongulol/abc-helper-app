import { describe, expect, it } from 'vitest';
import { isReadyToReconcile, isUnconfirmedWiseLink } from '@/lib/wise/reconcilable';

const wiseRow = (over: Partial<Parameters<typeof isReadyToReconcile>[0]> = {}) => ({
  status: 'sent',
  paid_at: '2026-07-28T21:57:08.853Z',
  payout_method: 'wise',
  wise_transfer_id: '2276187411',
  wise_locked_at: '2026-07-29T00:00:00.000Z',
  ...over,
});

describe('isReadyToReconcile', () => {
  it('a Wise row whose transfer Wise confirmed as paid', () => {
    expect(isReadyToReconcile(wiseRow())).toBe(true);
  });

  it('REFUSES a transfer id that was never confirmed paid', () => {
    // The 2026-07-28 shape: the row holds the app's own draft, which sat
    // `incoming_payment_waiting` and never locked. "Reconcile all pending" used
    // to stamp exactly this row reconciled.
    expect(isReadyToReconcile(wiseRow({ wise_locked_at: null }))).toBe(false);
  });

  it('refuses a Wise row with no transfer at all, and anything unpaid', () => {
    expect(isReadyToReconcile(wiseRow({ wise_transfer_id: null, wise_locked_at: null }))).toBe(
      false,
    );
    expect(isReadyToReconcile(wiseRow({ paid_at: null }))).toBe(false);
    expect(isReadyToReconcile(wiseRow({ status: 'draft' }))).toBe(false);
    expect(isReadyToReconcile(wiseRow({ status: 'reconciled' }))).toBe(false);
  });

  it('a non-Wise row needs nothing to confirm against', () => {
    // 452 BPI rows are paid by hand; paid_at is the whole record.
    expect(isReadyToReconcile({ status: 'sent', paid_at: 'x', payout_method: 'bpi' })).toBe(true);
    expect(isReadyToReconcile({ status: 'sent', paid_at: 'x', payout_method: null })).toBe(true);
    expect(isReadyToReconcile({ status: 'sent', paid_at: null, payout_method: 'bpi' })).toBe(false);
  });
});

describe('isUnconfirmedWiseLink — the tripwire', () => {
  it('flags a link that never locked, whatever the row status says', () => {
    // Already 'reconciled' is the case that matters: the damage is a green tick
    // over a transfer that never sent.
    expect(isUnconfirmedWiseLink(wiseRow({ status: 'reconciled', wise_locked_at: null }))).toBe(
      true,
    );
  });

  it('does not flag a confirmed link, an unlinked row, or a non-Wise row', () => {
    expect(isUnconfirmedWiseLink(wiseRow())).toBe(false);
    expect(isUnconfirmedWiseLink(wiseRow({ wise_transfer_id: null, wise_locked_at: null }))).toBe(
      false,
    );
    expect(
      isUnconfirmedWiseLink({ status: 'reconciled', payout_method: 'bpi', wise_locked_at: null }),
    ).toBe(false);
  });
});
