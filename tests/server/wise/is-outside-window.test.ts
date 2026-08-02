import { describe, expect, it, vi } from 'vitest';

// service.ts pulls in the Wise HTTP client, which validates env at import time.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

import { isCancellable } from '@/lib/wise/types';
import { isOutsideWindow } from '@/server/wise/service';

/** 2026-07-01→15, paid by the end of the month. */
const july = { periodStart: '2026-07-01', payDate: '2026-07-31' };

describe('isOutsideWindow — when a manual link has to say why', () => {
  it('a transfer inside the period needs no explanation', () => {
    expect(isOutsideWindow('2026-07-28T21:54:16Z', july)).toBe(false);
    expect(isOutsideWindow('2026-07-01T00:00:00Z', july)).toBe(false);
    expect(isOutsideWindow('2026-07-31T23:00:00Z', july)).toBe(false);
  });

  it('allows the fortnight of slack real runs land in', () => {
    // Payment is manual; a run can slip past the deadline without being wrong.
    expect(isOutsideWindow('2026-08-10T09:00:00Z', july)).toBe(false);
    expect(isOutsideWindow('2026-08-20T09:00:00Z', july)).toBe(true);
  });

  it('flags a transfer sent before the period even opened', () => {
    // Zagado's 2024-08-16→31 was paid on 08-13 — three days before it started.
    expect(isOutsideWindow('2024-08-13T18:53:00Z', { ...july, periodStart: '2024-08-16' })).toBe(
      true,
    );
  });

  it('treats unknown dates as inside — a missing pay_date proves nothing', () => {
    expect(isOutsideWindow(null, july)).toBe(false);
    expect(isOutsideWindow('2026-07-28T21:54:16Z', { periodStart: null, payDate: null })).toBe(
      false,
    );
    expect(isOutsideWindow('not a date', july)).toBe(false);
  });
});

describe('isCancellable — what the cancel button may touch', () => {
  it('only an in-flight draft', () => {
    expect(isCancellable('incoming_payment_waiting')).toBe(true);
    expect(isCancellable('processing')).toBe(true);
    // Stalled, not sent — the operator should be able to clear it.
    expect(isCancellable('waiting_recipient_input_to_proceed')).toBe(true);
  });

  it('never something that already paid, or is already dead', () => {
    expect(isCancellable('outgoing_payment_sent')).toBe(false);
    expect(isCancellable('completed')).toBe(false);
    expect(isCancellable('cancelled')).toBe(false);
    expect(isCancellable('bounced_back')).toBe(false);
    expect(isCancellable(null)).toBe(false);
    expect(isCancellable('')).toBe(false);
  });
});
