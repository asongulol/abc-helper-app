/**
 * Pure onboarding-stage derivation helpers.
 * These functions are side-effect-free and fully testable without a DB.
 */

import type { Database } from '@/db/types';

export type OnboardingStage = Database['public']['Enums']['onboarding_stage'];
export type AgreementKind = Database['public']['Enums']['agreement_kind'];

export interface OnboardingState {
  stage1Complete: boolean;
  stage2Complete: boolean;
  stage3Complete: boolean;
  completedAt: string | null;
  currentStage: OnboardingStage;
  nameMismatchFlag: boolean;
  stalled: boolean;
}

export interface StageInfo {
  /** Human-readable label. */
  label: string;
  /** Badge tone for the stage. */
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  /** Percentage completion 0-100. */
  pct: number;
  /** Whether the stage is complete. */
  complete: boolean;
  /** Whether the overall onboarding is done. */
  isFullyOnboarded: boolean;
}

const STAGE_RANK: Record<OnboardingStage, number> = {
  stage1_sign: 0,
  stage2_profile: 1,
  stage3_docs: 2,
  complete: 3,
};

/**
 * Derive a human-readable stage summary from the onboarding state.
 * Pure function — no IO.
 */
export const deriveStageInfo = (state: OnboardingState): StageInfo => {
  const { stage1Complete, stage2Complete, stage3Complete, completedAt, currentStage, stalled } =
    state;

  const isFullyOnboarded = !!completedAt && currentStage === 'complete';

  if (isFullyOnboarded) {
    return {
      label: 'Complete',
      tone: 'good',
      pct: 100,
      complete: true,
      isFullyOnboarded: true,
    };
  }

  if (stalled) {
    return {
      label: `${stageName(currentStage)} — Stalled`,
      tone: 'bad',
      pct: stagePct(stage1Complete, stage2Complete, stage3Complete),
      complete: false,
      isFullyOnboarded: false,
    };
  }

  return {
    label: stageName(currentStage),
    tone: stageRankOf(currentStage) === 0 ? 'neutral' : 'warn',
    pct: stagePct(stage1Complete, stage2Complete, stage3Complete),
    complete: false,
    isFullyOnboarded: false,
  };
};

const stageName = (stage: OnboardingStage): string => {
  switch (stage) {
    case 'stage1_sign':
      return 'Stage 1 – Signing';
    case 'stage2_profile':
      return 'Stage 2 – Profile';
    case 'stage3_docs':
      return 'Stage 3 – Documents';
    case 'complete':
      return 'Complete';
  }
};

const stageRankOf = (stage: OnboardingStage): number => STAGE_RANK[stage];

const stagePct = (s1: boolean, s2: boolean, s3: boolean): number => {
  let done = 0;
  if (s1) done += 1;
  if (s2) done += 1;
  if (s3) done += 1;
  return Math.round((done / 3) * 100);
};

/**
 * Return true if the contractor is blocked from advancing from stage 1
 * due to all required agreements already being signed (advance_from_stage1
 * scenario in portal-self).
 */
export const canAdvanceFromStage1 = (
  signedKinds: ReadonlyArray<AgreementKind>,
  requiredKinds: ReadonlyArray<AgreementKind> = [
    'ic_agreement',
    'non_compete',
    'confidentiality_nda',
    'baa',
  ],
): boolean => {
  const signed = new Set(signedKinds);
  return requiredKinds.every((k) => signed.has(k));
};

/**
 * Given a list of signed agreement kinds (in signing order) and the required
 * list, return the next unsigned agreement kind, or null if all signed.
 */
export const nextUnsignedAgreement = (
  signedKinds: ReadonlyArray<AgreementKind>,
  requiredKinds: ReadonlyArray<AgreementKind> = [
    'ic_agreement',
    'non_compete',
    'confidentiality_nda',
    'baa',
  ],
): AgreementKind | null => {
  const signed = new Set(signedKinds);
  return requiredKinds.find((k) => !signed.has(k)) ?? null;
};
