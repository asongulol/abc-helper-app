/**
 * completeOnboardingTab names the missing fields. Genel Montero (2026-10-09)
 * had GCash/PayMaya/PayPal filled but no Mobile; the old "1 field(s) still
 * required" success toast sent them hunting for a Wise Tag they didn't need.
 */

import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Tables } from '../../fixtures/supabase-fake';

const W = '33333333-3333-4333-8333-333333333333';
const world = vi.hoisted(() => ({ svc: null as unknown }));

vi.mock('@/db/clients/service', () => ({ createServiceClient: () => world.svc }));
vi.mock('@/db/clients/server', () => ({ createServerSupabase: async () => world.svc }));
vi.mock('@/server/auth/worker', () => ({ requireWorker: async () => ({ workerId: W }) }));
vi.mock('@/server/auth/admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/server/company', () => ({ getEmployerCompanyId: vi.fn() }));
vi.mock('@/server/audit', () => ({ logEvent: vi.fn(), logWorkerEvent: vi.fn() }));
vi.mock('@/server/crypto', () => ({
  encryptIfConfigured: async (s: string) => s,
  decryptIfNeeded: async (s: string) => s,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/payroll', () => ({ syncPackageHolds: vi.fn() }));

const { completeOnboardingTab } = await import('@/server/actions/portal');

const genel = (over: Record<string, unknown> = {}) => {
  const tables: Tables = {
    workers: [
      {
        id: W,
        first_name: 'Genel',
        last_name: 'Montero',
        mobile: null,
        ph_address: 'Butuan City',
        date_of_birth: '2000-01-30',
        emergency_name: 'Gemma',
        emergency_relationship: 'Parent',
        emergency_mobile: '+63 964',
        marital_status: 'Single',
        gcash: '0950',
        paymaya: '0964',
        paypal: 'N/A',
        wise_tag: null,
        ...over,
      },
    ],
    onboarding_progress: [
      { worker_id: W, stage1_complete: true, completed_at: null, current_stage: 'stage2_profile' },
    ],
  };
  const fake = fakeSupabase(tables);
  world.svc = fake.client;
  return fake.tables;
};

describe('completeOnboardingTab', () => {
  it('payout passes with any one method — no Wise Tag needed', async () => {
    genel();
    expect(await completeOnboardingTab({ tab: 'payout' })).toEqual({ ok: true });
  });

  it('names the field that is actually missing', async () => {
    const tables = genel();
    const res = await completeOnboardingTab({ tab: 'contact' });
    expect(res).toMatchObject({ ok: false, error: /still needed: Mobile\./ });
    expect(tables.onboarding_progress?.[0]).toMatchObject({ stage2_complete: false });
  });

  it('advances to stage 3 once mobile is filled', async () => {
    const tables = genel({ mobile: '09171234567' });
    expect(await completeOnboardingTab({ tab: 'contact' })).toEqual({ ok: true });
    expect(tables.onboarding_progress?.[0]).toMatchObject({
      stage2_complete: true,
      current_stage: 'stage3_docs',
    });
  });
});
