import { describe, expect, it } from 'vitest';
import { resolveDraftRow } from '@/lib/wise/draft-row';

describe('resolveDraftRow (Wise draft overrides)', () => {
  const row = { net_php: 12000, workers: { wise_recipient_id: 555 } };

  it('falls back to the worker default recipient + locked net when no override', () => {
    expect(resolveDraftRow(row)).toEqual({ recipientId: 555, amountPhp: 12000 });
    expect(resolveDraftRow(row, {})).toEqual({ recipientId: 555, amountPhp: 12000 });
  });

  it('honors a per-row recipient override', () => {
    expect(resolveDraftRow(row, { recipientId: 999 })).toEqual({
      recipientId: 999,
      amountPhp: 12000,
    });
  });

  it('honors a per-row amount override', () => {
    expect(resolveDraftRow(row, { amountPhp: 8000 })).toEqual({
      recipientId: 555,
      amountPhp: 8000,
    });
  });

  it('reports null recipient / zero amount so the caller can skip the row', () => {
    expect(resolveDraftRow({ net_php: 0, workers: null })).toEqual({
      recipientId: null,
      amountPhp: 0,
    });
    expect(resolveDraftRow({ net_php: null, workers: { wise_recipient_id: null } })).toEqual({
      recipientId: null,
      amountPhp: 0,
    });
  });
});
