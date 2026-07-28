import { describe, expect, it, vi } from 'vitest';

// service.ts pulls in the Wise HTTP client, which validates env at import time.
// triageDraftRow itself is pure — stub env so the module loads (same as client.test.ts).
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

import { triageDraftRow } from '@/server/wise/service';

describe('triageDraftRow (RP-09 — server-side double-draft guard)', () => {
  const row = { wise_transfer_id: null, net_php: 12000, workers: { wise_recipient_id: 555 } };

  it('drafts an eligible row at its saved recipient and locked net', () => {
    expect(triageDraftRow(row)).toEqual({ recipientId: 555, amountPhp: 12000 });
  });

  it('SKIPS a row that already carries a Wise transfer id', () => {
    // Two admins both see the row as undrafted and both hit "Pay via Wise API".
    // Without this, Wise holds two live transfers and the DB remembers only the
    // second — funding the batch pays the contractor twice.
    expect(triageDraftRow({ ...row, wise_transfer_id: '901234567' })).toEqual({
      skip: 'already drafted',
    });
  });

  it('skips an already-drafted row even when the UI sends overrides', () => {
    expect(
      triageDraftRow(
        { ...row, wise_transfer_id: '901234567' },
        { recipientId: 999, amountPhp: 8000 },
      ),
    ).toEqual({ skip: 'already drafted' });
  });

  it('still skips missing recipient / non-positive amount', () => {
    expect(triageDraftRow({ ...row, workers: { wise_recipient_id: null } })).toEqual({
      skip: 'no Wise recipient',
    });
    expect(triageDraftRow({ ...row, workers: null })).toEqual({ skip: 'no Wise recipient' });
    expect(triageDraftRow({ ...row, net_php: 0 })).toEqual({ skip: 'no amount' });
    expect(triageDraftRow({ ...row, net_php: null })).toEqual({ skip: 'no amount' });
  });

  it('honors per-row overrides on an undrafted row', () => {
    expect(triageDraftRow(row, { recipientId: 999 })).toEqual({
      recipientId: 999,
      amountPhp: 12000,
    });
    expect(triageDraftRow(row, { amountPhp: 8000 })).toEqual({ recipientId: 555, amountPhp: 8000 });
  });

  it('treats an absent wise_transfer_id field as undrafted', () => {
    expect(triageDraftRow({ net_php: 500, workers: { wise_recipient_id: 1 } })).toEqual({
      recipientId: 1,
      amountPhp: 500,
    });
  });
});
