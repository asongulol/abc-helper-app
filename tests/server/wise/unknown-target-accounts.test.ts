import { describe, expect, it, vi } from 'vitest';

// service.ts pulls in the Wise HTTP client, which validates env at import time.
vi.mock('@/server/env', () => ({ env: { WISE_API_TOKEN: 'test-token' } }));

import type { WiseTransfer } from '@/lib/wise/types';
import { unknownTargetAccounts } from '@/server/wise/plan-match';

// The transfer that paid Cecilia Velante for 2024-10-01→15 went to recipient
// 887961147, since deleted — so /v1/accounts?profile= never names it and the
// orphan sweep had nothing but the date window, which the transfer missed.
const t = (id: number, targetAccount: number | null): WiseTransfer =>
  ({ id, status: 'outgoing_payment_sent', targetAccount, targetValue: 10000 }) as WiseTransfer;

describe('unknownTargetAccounts', () => {
  const active = new Map([['972828504', 'Cecilia Velante']]);

  it('returns the accounts the active recipient list cannot name', () => {
    expect(unknownTargetAccounts([t(1, 972828504), t(2, 887961147)], active)).toEqual([
      '887961147',
    ]);
  });

  it('dedupes repeat payees and skips transfers with no target account', () => {
    const transfers = [t(1, 887961147), t(2, 887961147), t(3, null), t(4, 192306703)];
    expect(unknownTargetAccounts(transfers, active)).toEqual(['887961147', '192306703']);
  });

  it('asks for nothing when every payee is already named', () => {
    expect(unknownTargetAccounts([t(1, 972828504)], active)).toEqual([]);
  });
});
