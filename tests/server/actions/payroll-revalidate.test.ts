import { describe, expect, it, vi } from 'vitest';

// A period state change has to invalidate the client Router Cache, or the pages
// that list batches by state keep replaying their pre-lock render: locking in
// Calculate left Process & Pay saying "no payrolls ready" (and still showing the
// "not yet locked" waiting-upstream banner) until a hard reload.
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/server/auth/admin', () => ({
  getCurrentAdmin: async () => ({ isOwner: true, companyIds: [], userId: 'admin-1' }),
}));
vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => ({}) }));
vi.mock('@/db/clients/service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/server/audit', () => ({ logEvent: async () => {} }));
// Only the three writes/reads the lock path takes are stubbed — lockBlockedReason
// and lockWarningReason stay real, since they decide whether the lock happens.
vi.mock('@/db/queries/payroll', async (orig) => ({
  ...(await orig<typeof import('@/db/queries/payroll')>()),
  // Off-cycle: the lock skips every session / pending-time read for this kind.
  findPeriod: async () => ({ id: 'period-1', state: 'open', kind: 'off_cycle' }),
  fetchSavedPayments: async () => [
    { paymentId: 'pay-1', name: 'Ana', netPhp: 1000, payoutMethod: 'wise', inactive: false },
  ],
  lockPeriod: async () => {},
}));

const { lockPeriod } = await import('@/server/actions/payroll');

const COMPANY = '11111111-1111-4111-8111-111111111111';

describe('lockPeriod', () => {
  it('revalidates so the locked batch appears in Process & Pay', async () => {
    const res = await lockPeriod({
      companyId: COMPANY,
      periodStart: '2026-07-16',
      periodEnd: '2026-07-31',
    });
    expect(res.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalled();
  });
});
