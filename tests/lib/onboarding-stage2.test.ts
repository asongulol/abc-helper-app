/**
 * Stage 2 ticks itself off from the profile row — no "Mark complete" button.
 * Genel Montero (2026-10-09) had three payout methods and a blank Mobile; the
 * card must say "Mobile", never imply a Wise Tag.
 */

import { describe, expect, it, vi } from 'vitest';
import { isStage2Complete, stage2Missing, stage2Summary } from '@/lib/onboarding/stage2';
import { fakeSupabase, type Tables } from '../fixtures/supabase-fake';

const W = '33333333-3333-4333-8333-333333333333';
const genel = {
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
  profile_extras: {
    nickname: 'Gen',
    favorite_color: 'blue',
    favorite_food: 'adobo',
    tshirt_size: 'M',
    shoe_size: '8',
    hobbies: 'reading',
    motto: 'keep going',
  },
};

describe('stage2Missing', () => {
  it('payout passes with any one method — no Wise Tag needed', () => {
    const m = stage2Missing(genel);
    expect(m).toEqual({ contact: ['Mobile'], personal: [], payout: [], about: [] });
    expect(isStage2Complete(m)).toBe(false);
    expect(stage2Summary(m)).toBe('Contact still needs: Mobile.');
  });

  it('completes once mobile is filled', () => {
    const m = stage2Missing({ ...genel, mobile: '0917' });
    expect(isStage2Complete(m)).toBe(true);
    expect(stage2Summary(m)).toBeNull();
  });

  it('About me is required — reads workers.profile_extras', () => {
    const m = stage2Missing({ ...genel, mobile: '0917', profile_extras: { nickname: 'Gen' } });
    expect(m.about).toEqual([
      'Favorite color',
      'Favorite food',
      'T-shirt size',
      'Shoe size',
      'Hobbies',
      'Personal motto',
    ]);
    expect(stage2Missing({ ...genel, profile_extras: null }).about).toHaveLength(7);
    expect(isStage2Complete(m)).toBe(false);
  });

  it('names the payout rule when no method is set', () => {
    const m = stage2Missing({ ...genel, gcash: '', paymaya: ' ', paypal: null });
    expect(m.payout).toEqual(['at least one payout method (GCash, PayMaya, PayPal or Wise Tag)']);
  });
});

vi.mock('server-only', () => ({}));
const { syncStage2 } = await import('@/server/onboarding/stage2');

const boot = (worker: Record<string, unknown>, progress: Record<string, unknown>) => {
  const tables: Tables = {
    workers: [worker],
    onboarding_progress: [{ worker_id: W, ...progress }],
  };
  const fake = fakeSupabase(tables);
  return { svc: fake.client, tables: fake.tables };
};

describe('syncStage2', () => {
  it('advances to stage 3 when the profile is complete', async () => {
    const { svc, tables } = boot(
      { ...genel, mobile: '0917' },
      { stage1_complete: true, stage2_complete: false, current_stage: 'stage2_profile' },
    );
    await syncStage2(svc as never, W);
    expect(tables.onboarding_progress?.[0]).toMatchObject({
      stage2_complete: true,
      current_stage: 'stage3_docs',
    });
  });

  it('reports what is missing and leaves progress alone', async () => {
    const { svc, tables } = boot(genel, {
      stage1_complete: true,
      stage2_complete: false,
      current_stage: 'stage2_profile',
    });
    expect((await syncStage2(svc as never, W)).contact).toEqual(['Mobile']);
    expect(tables.onboarding_progress?.[0]).toMatchObject({ current_stage: 'stage2_profile' });
  });

  it('never reopens a finished onboarding or skips stage 1', async () => {
    const done = boot(genel, {
      stage1_complete: true,
      stage2_complete: true,
      current_stage: 'complete',
      completed_at: '2025-01-01',
    });
    await syncStage2(done.svc as never, W);
    expect(done.tables.onboarding_progress?.[0]).toMatchObject({ stage2_complete: true });

    const unsigned = boot({ ...genel, mobile: '0917' }, { stage1_complete: false });
    await syncStage2(unsigned.svc as never, W);
    expect(unsigned.tables.onboarding_progress?.[0]).not.toHaveProperty('stage2_complete', true);
  });
});
