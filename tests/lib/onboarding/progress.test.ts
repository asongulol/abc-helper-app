import {
  canAdvanceFromStage1,
  deriveStageInfo,
  nextUnsignedAgreement,
} from '@/lib/onboarding/progress';
import { describe, expect, it } from 'vitest';

describe('deriveStageInfo', () => {
  it('returns Complete when fully onboarded', () => {
    const info = deriveStageInfo({
      stage1Complete: true,
      stage2Complete: true,
      stage3Complete: true,
      completedAt: '2026-01-01T00:00:00Z',
      currentStage: 'complete',
      nameMismatchFlag: false,
      stalled: false,
    });
    expect(info.label).toBe('Complete');
    expect(info.tone).toBe('good');
    expect(info.pct).toBe(100);
    expect(info.isFullyOnboarded).toBe(true);
  });

  it('returns Stage 1 label when on stage1_sign', () => {
    const info = deriveStageInfo({
      stage1Complete: false,
      stage2Complete: false,
      stage3Complete: false,
      completedAt: null,
      currentStage: 'stage1_sign',
      nameMismatchFlag: false,
      stalled: false,
    });
    expect(info.label).toBe('Stage 1 – Signing');
    expect(info.pct).toBe(0);
    expect(info.isFullyOnboarded).toBe(false);
  });

  it('shows 33% when stage1 done', () => {
    const info = deriveStageInfo({
      stage1Complete: true,
      stage2Complete: false,
      stage3Complete: false,
      completedAt: null,
      currentStage: 'stage2_profile',
      nameMismatchFlag: false,
      stalled: false,
    });
    expect(info.pct).toBe(33);
  });

  it('shows 67% when stages 1+2 done', () => {
    const info = deriveStageInfo({
      stage1Complete: true,
      stage2Complete: true,
      stage3Complete: false,
      completedAt: null,
      currentStage: 'stage3_docs',
      nameMismatchFlag: false,
      stalled: false,
    });
    expect(info.pct).toBe(67);
  });

  it('appends Stalled suffix when stalled=true', () => {
    const info = deriveStageInfo({
      stage1Complete: false,
      stage2Complete: false,
      stage3Complete: false,
      completedAt: null,
      currentStage: 'stage1_sign',
      nameMismatchFlag: false,
      stalled: true,
    });
    expect(info.label).toContain('Stalled');
    expect(info.tone).toBe('bad');
  });
});

describe('canAdvanceFromStage1', () => {
  const required = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'] as const;

  it('returns true when all required are signed', () => {
    expect(canAdvanceFromStage1([...required], [...required])).toBe(true);
  });

  it('returns false when one is missing', () => {
    expect(canAdvanceFromStage1(['ic_agreement', 'non_compete', 'baa'], [...required])).toBe(false);
  });

  it('returns false for empty signed list', () => {
    expect(canAdvanceFromStage1([], [...required])).toBe(false);
  });
});

describe('nextUnsignedAgreement', () => {
  it('returns the first unsigned agreement', () => {
    expect(nextUnsignedAgreement(['ic_agreement'])).toBe('non_compete');
  });

  it('returns null when all signed', () => {
    expect(
      nextUnsignedAgreement(['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa']),
    ).toBeNull();
  });

  it('returns the first agreement when none signed', () => {
    expect(nextUnsignedAgreement([])).toBe('ic_agreement');
  });
});
