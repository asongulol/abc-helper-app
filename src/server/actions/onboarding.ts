'use server';

/**
 * Onboarding admin detail — fetches a single contractor's signed-agreement
 * ledger and uploaded documents for the onboarding review panel (manifest 28).
 * Admin-only; read-only (review mutations use `reviewDocument` in portal.ts).
 */

import { createServiceClient } from '@/db/clients/service';
import { parseOnboardingConfig } from '@/db/queries/config';
import { fetchAgreements, fetchSignatures } from '@/db/queries/onboarding';
import type { Database } from '@/db/types';
import { type DocSlotStatus, deriveDocChecklist } from '@/lib/onboarding/documents';
import { logEvent } from '@/server/audit';
import { requireAdmin } from '@/server/auth/admin';
import { revalidatePath } from 'next/cache';

type AgreementKind = Database['public']['Enums']['agreement_kind'];
type OnboardingStage = Database['public']['Enums']['onboarding_stage'];

export type SimpleResult = { ok: true } | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e ?? 'Unknown error'),
});

export interface OnbSignatureLite {
  agreementKind: Database['public']['Enums']['agreement_kind'];
  signedLegalName: string;
  signedAt: string;
  ipAddress: string;
  docVersion: string;
}

export interface OnbDocLite {
  id: string;
  kind: Database['public']['Enums']['document_kind'];
  title: string | null;
  reviewStatus: Database['public']['Enums']['review_status'];
  storagePath: string | null;
  issuedOn: string | null;
  /** Defer-until date for a deferred doc (review uses expires_on as the due date). */
  expiresOn: string | null;
  side: string | null;
  createdAt: string;
}

export interface OnbAgreementLite {
  agreementKind: AgreementKind;
  countersignedAt: string | null;
  countersignedName: string | null;
  fPosition: string | null;
  fRate: string | null;
  fStartDate: string | null;
}

export interface OnbProfileLite {
  mobile: string | null;
  phAddress: string | null;
  permanentAddress: string | null;
  postalCode: string | null;
  dateOfBirth: string | null;
  emergencyName: string | null;
  emergencyRelationship: string | null;
  emergencyMobile: string | null;
  maritalStatus: string | null;
  educationLevel: string | null;
  course: string | null;
  yearGraduated: string | null;
  school: string | null;
  gcash: string | null;
  paymaya: string | null;
  paypal: string | null;
  wiseTag: string | null;
  extras: Record<string, unknown>;
}

export type OnboardingDetailResult =
  | {
      ok: true;
      data: {
        signatures: OnbSignatureLite[];
        agreements: OnbAgreementLite[];
        documents: OnbDocLite[];
        /** Required-document checklist incl. MISSING slots (what's still owed). */
        documentChecklist: DocSlotStatus[];
        profile: OnbProfileLite | null;
        loginEmail: string | null;
      };
    }
  | { ok: false; error: string };

export async function getOnboardingDetail(workerId: string): Promise<OnboardingDetailResult> {
  try {
    await requireAdmin();
    const db = createServiceClient();

    const [sigs, agrs, settingsRes] = await Promise.all([
      fetchSignatures(db, workerId),
      fetchAgreements(db, workerId),
      db.from('portal_settings').select('onboarding_config').eq('id', 1).maybeSingle(),
    ]);
    const { data: docs, error } = await db
      .from('documents')
      .select(
        'id, kind, title, review_status, storage_path, issued_on, expires_on, side, created_at',
      )
      .eq('worker_id', workerId)
      .order('created_at', { ascending: true });
    if (error) return { ok: false, error: error.message };

    const documents: OnbDocLite[] = (docs ?? []).map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      reviewStatus: d.review_status,
      storagePath: d.storage_path,
      issuedOn: d.issued_on,
      expiresOn: d.expires_on,
      side: d.side,
      createdAt: d.created_at,
    }));

    // Resolve the configured required docs against the uploads so the review
    // panel can show what's still MISSING (not just what was uploaded).
    const cfg = parseOnboardingConfig(settingsRes.data?.onboarding_config);
    const documentChecklist = deriveDocChecklist(cfg.documents, documents);

    const { data: prof } = await db
      .from('workers')
      .select(
        'mobile, ph_address, permanent_address, postal_code, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, profile_extras',
      )
      .eq('id', workerId)
      .maybeSingle();

    const { data: loginRow } = await db
      .from('contractor_logins')
      .select('email')
      .eq('worker_id', workerId)
      .maybeSingle();

    return {
      ok: true,
      data: {
        signatures: sigs.map((s) => ({
          agreementKind: s.agreementKind,
          signedLegalName: s.signedLegalName,
          signedAt: s.signedAt,
          ipAddress: s.ipAddress != null ? String(s.ipAddress) : '',
          docVersion: s.docVersion,
        })),
        agreements: agrs.map((a) => ({
          agreementKind: a.agreementKind,
          countersignedAt: a.countersignedAt,
          countersignedName: a.countersignedName,
          fPosition: a.fPosition,
          fRate: a.fRate,
          fStartDate: a.fStartDate,
        })),
        documents,
        documentChecklist,
        profile: prof
          ? {
              mobile: prof.mobile,
              phAddress: prof.ph_address,
              permanentAddress: prof.permanent_address,
              postalCode: prof.postal_code,
              dateOfBirth: prof.date_of_birth,
              emergencyName: prof.emergency_name,
              emergencyRelationship: prof.emergency_relationship,
              emergencyMobile: prof.emergency_mobile,
              maritalStatus: prof.marital_status,
              educationLevel: prof.education_level,
              course: prof.course,
              yearGraduated: prof.year_graduated,
              school: prof.school,
              gcash: prof.gcash,
              paymaya: prof.paymaya,
              paypal: prof.paypal,
              wiseTag: prof.wise_tag,
              extras:
                prof.profile_extras && typeof prof.profile_extras === 'object'
                  ? (prof.profile_extras as Record<string, unknown>)
                  : {},
            }
          : null,
        loginEmail: loginRow?.email ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to load detail.' };
  }
}

// ─── Stage overrides (manifest 28: ↺ Stage N · ✓ Mark complete · ↺ Reset) ───────

const ISO_NOW = () => new Date().toISOString();

/** Recompute current_stage + completed_at from the three stage booleans. */
function deriveStage(
  s1: boolean,
  s2: boolean,
  s3: boolean,
): {
  current_stage: OnboardingStage;
  completed_at: string | null;
} {
  if (s1 && s2 && s3) return { current_stage: 'complete', completed_at: ISO_NOW() };
  const current_stage: OnboardingStage = !s1
    ? 'stage1_sign'
    : !s2
      ? 'stage2_profile'
      : 'stage3_docs';
  return { current_stage, completed_at: null };
}

/** Toggle a single onboarding stage (admin override) and recompute progress. */
export async function setOnboardingStage(args: {
  workerId: string;
  stage: 1 | 2 | 3;
  complete: boolean;
}): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const { data: row, error } = await db
      .from('onboarding_progress')
      .select('stage1_complete, stage2_complete, stage3_complete')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!row) return fail('No onboarding record for this contractor.');

    const s1 = args.stage === 1 ? args.complete : row.stage1_complete;
    const s2 = args.stage === 2 ? args.complete : row.stage2_complete;
    const s3 = args.stage === 3 ? args.complete : row.stage3_complete;
    const d = deriveStage(s1, s2, s3);
    const { error: upErr } = await db
      .from('onboarding_progress')
      .update({
        stage1_complete: s1,
        stage2_complete: s2,
        stage3_complete: s3,
        ...d,
        updated_at: ISO_NOW(),
      })
      .eq('worker_id', args.workerId);
    if (upErr) return fail(upErr.message);
    await logEvent({
      action: 'onboarding.stage_override',
      entity: args.workerId,
      detail: { stage: args.stage, complete: args.complete, by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Mark all onboarding stages complete (admin override). */
export async function markOnboardingComplete(args: { workerId: string }): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const { error } = await db
      .from('onboarding_progress')
      .update({
        stage1_complete: true,
        stage2_complete: true,
        stage3_complete: true,
        current_stage: 'complete',
        completed_at: ISO_NOW(),
        updated_at: ISO_NOW(),
      })
      .eq('worker_id', args.workerId);
    if (error) return fail(error.message);
    await logEvent({
      action: 'onboarding.mark_complete',
      entity: args.workerId,
      detail: { by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Reset onboarding to stage 1 (admin override). */
export async function resetOnboarding(args: { workerId: string }): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const { error } = await db
      .from('onboarding_progress')
      .update({
        stage1_complete: false,
        stage2_complete: false,
        stage3_complete: false,
        current_stage: 'stage1_sign',
        completed_at: null,
        updated_at: ISO_NOW(),
      })
      .eq('worker_id', args.workerId);
    if (error) return fail(error.message);
    await logEvent({
      action: 'onboarding.reset',
      entity: args.workerId,
      detail: { by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Per-agreement edits (manifest 28: Edit date · Edit prefill) ─────────────────

/** Edit the signed date on a contractor's agreement signature(s). */
export async function editAgreementDate(args: {
  workerId: string;
  agreementKind: AgreementKind;
  signedDate: string;
}): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.signedDate)) return fail('Date must be YYYY-MM-DD.');
    const db = createServiceClient();
    const { error } = await db
      .from('onboarding_signatures')
      .update({ signed_date: args.signedDate })
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind);
    if (error) return fail(error.message);
    await logEvent({
      action: 'onboarding.edit_agreement_date',
      entity: args.workerId,
      detail: { kind: args.agreementKind, date: args.signedDate, by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Edit the prefilled engagement terms shown on a prepared agreement. */
export async function editAgreementPrefill(args: {
  workerId: string;
  agreementKind: AgreementKind;
  position?: string | null;
  rate?: string | null;
  startDate?: string | null;
}): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const patch: {
      f_position?: string | null;
      f_rate?: string | null;
      f_start_date?: string | null;
    } = {};
    if (args.position !== undefined) patch.f_position = args.position || null;
    if (args.rate !== undefined) patch.f_rate = args.rate || null;
    if (args.startDate !== undefined) patch.f_start_date = args.startDate || null;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await db
      .from('onboarding_agreements')
      .update(patch)
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind);
    if (error) return fail(error.message);
    await logEvent({
      action: 'onboarding.edit_agreement_prefill',
      entity: args.workerId,
      detail: { kind: args.agreementKind, by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
