'use server';

/**
 * Contractor-portal actions — CONTRACT FILE (legacy edge fns `portal-self`,
 * `portal-sign`, `portal-countersign`, `portal-review`).
 * Implementations are filled in by the server-layer build; the portal screens
 * and admin review screens code against these signatures.
 */

import type { ActionResult } from '@/server/actions/portal-admin';

const notWired = (): never => {
  throw new Error('portal actions not wired yet — see src/server/actions/portal.ts');
};

/* ---------- portal-self (contractor, own rows) ---------- */

export async function updateOwnProfile(
  _fields: Record<string, string | null>,
): Promise<ActionResult> {
  return notWired();
}

export async function completeOnboardingTab(_args: { tab: string }): Promise<ActionResult> {
  return notWired();
}

export async function advanceFromStage1(): Promise<ActionResult> {
  return notWired();
}

export async function finishOnboarding(): Promise<ActionResult> {
  return notWired();
}

/* ---------- portal-sign (contractor signature) ---------- */

export async function signAgreement(_args: {
  agreementKey: string;
  signatureDataUrl: string;
  typedName: string;
}): Promise<ActionResult> {
  return notWired();
}

/* ---------- portal-countersign (admin) ---------- */

export async function countersignAgreement(_args: {
  workerId: string;
  agreementKey: string;
  signatureDataUrl: string;
}): Promise<ActionResult> {
  return notWired();
}

/* ---------- portal-review (admin doc review) ---------- */

export async function reviewDocument(_args: {
  documentId: string;
  decision: 'approve' | 'needs_replacement' | 'waive' | 'defer';
  note?: string;
}): Promise<ActionResult> {
  return notWired();
}

export async function setSignedDate(_args: {
  documentId: string;
  signedDate: string;
}): Promise<ActionResult> {
  return notWired();
}
