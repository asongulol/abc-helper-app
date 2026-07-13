'use server';

/**
 * Onboarding admin detail — fetches a single contractor's signed-agreement
 * ledger and uploaded documents for the onboarding review panel (manifest 28).
 * Admin-only; read-only (review mutations use `reviewDocument` in portal.ts).
 */

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/db/clients/service';
import { parseOnboardingConfig } from '@/db/queries/config';
import { fetchAgreements, fetchSignatures } from '@/db/queries/onboarding';
import type { Database } from '@/db/types';
import { humanizeError } from '@/lib/errors';
import { type DocSlotStatus, deriveDocChecklist } from '@/lib/onboarding/documents';
import { logEvent } from '@/server/audit';
import { requireAdmin } from '@/server/auth/admin';

type AgreementKind = Database['public']['Enums']['agreement_kind'];
type OnboardingStage = Database['public']['Enums']['onboarding_stage'];

export type SimpleResult = { ok: true } | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: humanizeError(e),
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

    // One parallel wave (the six reads are independent), and no signature
    // blobs/decryption — the modal shows only signature metadata; the drawn
    // image is print-route-only.
    const [sigs, agrs, settingsRes, docsRes, profRes, loginRes] = await Promise.all([
      fetchSignatures(db, workerId, { withData: false }),
      fetchAgreements(db, workerId),
      db.from('portal_settings').select('onboarding_config').eq('id', 1).maybeSingle(),
      db
        .from('documents')
        .select(
          'id, kind, title, review_status, storage_path, issued_on, expires_on, side, created_at',
        )
        .eq('worker_id', workerId)
        .order('created_at', { ascending: true }),
      db
        .from('workers')
        .select(
          'mobile, ph_address, permanent_address, postal_code, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, profile_extras',
        )
        .eq('id', workerId)
        .maybeSingle(),
      db.from('contractor_logins').select('email').eq('worker_id', workerId).maybeSingle(),
    ]);
    const docs = docsRes.data;
    if (docsRes.error) return { ok: false, error: docsRes.error.message };

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

    const prof = profRes.data;
    const loginRow = loginRes.data;

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
    return {
      ok: false,
      error: humanizeError(e, 'Failed to load detail.'),
    };
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

// Local copy — portal.ts's AGREEMENT_ORDER can't be imported (no non-async
// exports from a 'use server' module).
const AGREEMENT_KINDS: readonly AgreementKind[] = [
  'ic_agreement',
  'non_compete',
  'confidentiality_nda',
  'baa',
];

/**
 * Permanently delete a mistakenly-signed agreement: the signature ledger rows
 * AND the countersign/prefill card for that kind, so the contractor can
 * re-sign from scratch (admin re-prepares the prefill). Stage 1 is recomputed
 * from the remaining signed agreements — deleting one un-completes it. The
 * destroyed signature metadata is preserved in the audit log.
 */
export async function deleteAgreementSignature(args: {
  workerId: string;
  agreementKind: AgreementKind;
}): Promise<SimpleResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();

    // Capture what's being destroyed for the audit trail.
    const { data: sigs } = await db
      .from('onboarding_signatures')
      .select('signed_legal_name, signed_at, status')
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind);
    const { data: agr } = await db
      .from('onboarding_agreements')
      .select('countersigned_at, countersigned_name')
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind)
      .maybeSingle();
    if (!sigs?.length && !agr) return fail('Nothing to delete for this agreement.');

    const delSig = await db
      .from('onboarding_signatures')
      .delete()
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind);
    if (delSig.error) return fail(delSig.error.message);
    const delAgr = await db
      .from('onboarding_agreements')
      .delete()
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', args.agreementKind);
    if (delAgr.error) return fail(delAgr.error.message);

    // Recompute stage 1 from the remaining signed agreements.
    const { data: remaining } = await db
      .from('onboarding_signatures')
      .select('agreement_kind')
      .eq('worker_id', args.workerId)
      .eq('status', 'signed');
    const signedKinds = new Set((remaining ?? []).map((s) => s.agreement_kind));
    const s1 = AGREEMENT_KINDS.every((k) => signedKinds.has(k));
    const { data: row } = await db
      .from('onboarding_progress')
      .select('stage2_complete, stage3_complete')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (row) {
      const d = deriveStage(s1, row.stage2_complete, row.stage3_complete);
      const up = await db
        .from('onboarding_progress')
        .update({ stage1_complete: s1, ...d, updated_at: ISO_NOW() })
        .eq('worker_id', args.workerId);
      if (up.error) return fail(up.error.message);
    }

    await logEvent({
      action: 'agreement.deleted',
      entity: `${args.agreementKind} · ${args.workerId}`,
      detail: {
        worker_id: args.workerId,
        agreement_kind: args.agreementKind,
        signatures: (sigs ?? []).map((s) => ({
          signed_legal_name: s.signed_legal_name,
          signed_at: s.signed_at,
          status: s.status,
        })),
        countersigned_at: agr?.countersigned_at ?? null,
        countersigned_name: agr?.countersigned_name ?? null,
        by: admin.email,
      },
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
      detail: {
        kind: args.agreementKind,
        date: args.signedDate,
        by: admin.email,
      },
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
