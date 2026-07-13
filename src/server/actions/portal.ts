'use server';

/**
 * Contractor-portal actions — IMPLEMENTED (ported from legacy edge fns
 * `portal-self`, `portal-sign`, `portal-countersign`, `portal-review`).
 *
 * Contractor actions use requireWorker() (RLS user client, own rows).
 * Admin review/countersign use requireAdmin() + createServiceClient() after
 * role checks (service client needed because RLS has no contractor write policy).
 */

import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import {
  clearFilelessDocumentSlot,
  fetchApprovedDocumentsForWorker,
  fetchOnboardingProgressForWorker,
  resolveMissingDocumentSlot,
  updateDocumentReview,
  updateOnboardingProgressStage3,
} from '@/db/queries/documents';
import { fetchOwnProfile, fetchPortalSettings, insertMoodCheckin } from '@/db/queries/portal';
import type { Database } from '@/db/types';
import { humanizeError } from '@/lib/errors';
import { isStage3Complete } from '@/lib/onboarding/documents';
import { validateProfileFields } from '@/lib/profile/validate';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { requireAdmin } from '@/server/auth/admin';
import { requireWorker } from '@/server/auth/worker';
import { getEmployerCompanyId } from '@/server/company';
import { encryptIfConfigured } from '@/server/crypto';

/* ---------- SAFE_FIELDS mirror of portal-self edge fn ---------- */

const SAFE_FIELDS = new Set([
  'first_name',
  'middle_name',
  'last_name',
  'mobile',
  'ph_address',
  'date_of_birth',
  'gcash',
  'paymaya',
  'paypal',
  'wise_tag',
  'emergency_name',
  'emergency_relationship',
  'emergency_mobile',
  'permanent_address',
  'address_landmark',
  'postal_code',
  'marital_status',
  'education_level',
  'course',
  'year_graduated',
  'school',
  'nickname',
  'favorite_color',
  'favorite_food',
  'tshirt_size',
  'shoe_size',
  'hobbies',
  'motto',
]);

const EXTRA_KEYS = new Set([
  'nickname',
  'favorite_color',
  'favorite_food',
  'tshirt_size',
  'shoe_size',
  'hobbies',
  'motto',
]);

type FieldPatch = Record<string, string | null>;

/** The signed-agreement set, in stage-1 signing order (DB `agreement_kind` enum). */
type AgreementKind = Database['public']['Enums']['agreement_kind'];
const AGREEMENT_ORDER: readonly AgreementKind[] = [
  'ic_agreement',
  'non_compete',
  'confidentiality_nda',
  'baa',
];

function buildPatch(
  inFields: Record<string, string | null>,
  allowed: Set<string>,
): { patch: FieldPatch; extra: FieldPatch } {
  const patch: FieldPatch = {};
  const extra: FieldPatch = {};
  for (const [k, v] of Object.entries(inFields)) {
    if (!allowed.has(k)) continue;
    const val = typeof v === 'string' && v.trim() === '' ? null : v;
    if (EXTRA_KEYS.has(k)) extra[k] = val;
    else patch[k] = val;
  }
  return { patch, extra };
}

/* ---------- portal-self (contractor, own rows) ---------- */

/**
 * Update own whitelisted profile fields. Intersection of admin editable_fields
 * config and SAFE_FIELDS (mirrors portal-self edge fn exactly).
 */
export async function updateOwnProfile(
  fields: Record<string, string | null>,
): Promise<ActionResult> {
  const worker = await requireWorker();

  try {
    const db = await createServerSupabase();
    const settings = await fetchPortalSettings(db);
    const adminAllowed: string[] = Array.isArray(settings?.editable_fields)
      ? (settings.editable_fields as string[])
      : [];
    const allowed = new Set(adminAllowed.filter((f) => SAFE_FIELDS.has(f)));

    const invalid = validateProfileFields(
      Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.has(k))),
    );
    if (invalid) return { ok: false, error: invalid };

    const { patch, extra } = buildPatch(fields, allowed);

    // workers.first_name / last_name are NOT NULL — buildPatch turns a cleared
    // input into null, which would otherwise hit Postgres as a raw not-null
    // violation. Catch it here with copy that matches the rest of the app.
    if (patch.first_name === null) return { ok: false, error: "First name can't be empty." };
    if (patch.last_name === null) return { ok: false, error: "Last name can't be empty." };

    // Merge profile_extras without clobbering other culture fields
    if (Object.keys(extra).length > 0) {
      const profile = await fetchOwnProfile(db, worker.workerId);
      const cur =
        profile?.profile_extras && typeof profile.profile_extras === 'object'
          ? (profile.profile_extras as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(extra)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      (patch as Record<string, unknown>).profile_extras = merged;
    }

    if (!Object.keys(patch).length) {
      return {
        ok: false,
        error: 'No editable fields in request (check the admin portal settings).',
      };
    }

    // Service client required because RLS has no direct worker write policy for
    // contractors; the whitelist above is the security gate.
    const svc = createServiceClient();
    // `patch` is the whitelisted-field map (the security gate above); cast to the
    // table Update type for the typed client.
    const update = patch as Database['public']['Tables']['workers']['Update'];
    const { error } = await svc.from('workers').update(update).eq('id', worker.workerId);
    if (error) return { ok: false, error: `Update failed: ${error.message}` };

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Update failed.'),
    };
  }
}

/** Mark a Stage-2 onboarding tab as complete (mirrors portal-self complete_tab). */
export async function completeOnboardingTab(args: { tab: string }): Promise<ActionResult> {
  const worker = await requireWorker();
  const validTabs = new Set(['contact', 'personal', 'payout', 'about']);
  if (!validTabs.has(args.tab)) return { ok: false, error: 'Unknown tab.' };

  try {
    const db = await createServerSupabase();

    // Verify stage 1 done
    const { data: op } = await db
      .from('onboarding_progress')
      .select('stage1_complete, completed_at, current_stage')
      .eq('worker_id', worker.workerId)
      .maybeSingle();
    if (!op?.stage1_complete) return { ok: false, error: 'Finish signing your agreements first.' };
    if (op.completed_at) return { ok: false, error: 'Onboarding is already complete.' };

    // Service client for the worker write (no contractor write RLS).
    const svc = createServiceClient();
    const now = new Date().toISOString();

    // Re-validate tabs from current worker row
    const { data: w } = await svc
      .from('workers')
      .select(
        'first_name, last_name, mobile, ph_address, date_of_birth, postal_code, emergency_name, emergency_relationship, emergency_mobile, marital_status, gcash, paymaya, paypal, wise_tag',
      )
      .eq('id', worker.workerId)
      .maybeSingle();

    // Minimal validation mirrors portal-self validateTab logic
    const nonEmpty = (v: unknown) => v != null && String(v).trim() !== '';
    const errors: string[] = [];
    if (args.tab === 'contact') {
      if (!nonEmpty(w?.first_name)) errors.push('first_name');
      if (!nonEmpty(w?.last_name)) errors.push('last_name');
      if (!nonEmpty(w?.ph_address)) errors.push('ph_address');
      if (!nonEmpty(w?.mobile)) errors.push('mobile');
      if (!nonEmpty(w?.date_of_birth)) errors.push('date_of_birth');
    } else if (args.tab === 'personal') {
      if (!nonEmpty(w?.emergency_name)) errors.push('emergency_name');
      if (!nonEmpty(w?.emergency_relationship)) errors.push('emergency_relationship');
      if (!nonEmpty(w?.emergency_mobile)) errors.push('emergency_mobile');
      if (!nonEmpty(w?.marital_status)) errors.push('marital_status');
    } else if (args.tab === 'payout') {
      if (
        !['gcash', 'paymaya', 'paypal', 'wise_tag'].some((f) =>
          nonEmpty((w as Record<string, unknown> | null)?.[f]),
        )
      ) {
        errors.push('payout');
      }
    }

    // Check overall stage2 completion
    const contactOk =
      nonEmpty(w?.first_name) &&
      nonEmpty(w?.last_name) &&
      nonEmpty(w?.ph_address) &&
      nonEmpty(w?.mobile) &&
      nonEmpty(w?.date_of_birth);
    const personalOk =
      nonEmpty(w?.emergency_name) &&
      nonEmpty(w?.emergency_relationship) &&
      nonEmpty(w?.emergency_mobile) &&
      nonEmpty(w?.marital_status);
    const payoutOk = ['gcash', 'paymaya', 'paypal', 'wise_tag'].some((f) =>
      nonEmpty((w as Record<string, unknown> | null)?.[f]),
    );
    const stage2Complete = contactOk && personalOk && payoutOk;

    const RANK: Record<string, number> = {
      stage1_sign: 0,
      stage2_profile: 1,
      stage3_docs: 2,
      complete: 3,
    };
    const curStage = op.current_stage ?? 'stage2_profile';
    const nextStage =
      stage2Complete && (RANK.stage3_docs ?? 0) > (RANK[curStage] ?? 0) ? 'stage3_docs' : curStage;

    const { error: opErr } = await svc
      .from('onboarding_progress')
      .update({
        stage2_last_tab: args.tab,
        stage2_complete: stage2Complete,
        current_stage: nextStage,
        updated_at: now,
      })
      .eq('worker_id', worker.workerId);
    if (opErr) return { ok: false, error: `Progress update failed: ${opErr.message}` };

    return {
      ok: true,
      ...(errors.length
        ? {
            message: `Tab saved with ${errors.length} field(s) still required.`,
          }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Tab completion failed.'),
    };
  }
}

/** Advance from Stage 1 when all required agreements are already signed. */
export async function advanceFromStage1(): Promise<ActionResult> {
  const worker = await requireWorker();

  try {
    const db = await createServerSupabase();
    const { data: op } = await db
      .from('onboarding_progress')
      .select('stage1_complete, completed_at, current_stage')
      .eq('worker_id', worker.workerId)
      .maybeSingle();
    if (!op) return { ok: false, error: 'No onboarding in progress for this login.' };
    if (op.completed_at) return { ok: true, message: 'Already complete.' };

    // Check required agreements signed
    const { data: sigs } = await db
      .from('onboarding_signatures')
      .select('agreement_kind')
      .eq('worker_id', worker.workerId)
      .eq('status', 'signed');
    const signed = new Set((sigs ?? []).map((s) => s.agreement_kind));
    const allSigned = AGREEMENT_ORDER.every((k) => signed.has(k));
    if (!allSigned) return { ok: false, error: 'Sign all your agreements first.' };

    const RANK: Record<string, number> = {
      stage1_sign: 0,
      stage2_profile: 1,
      stage3_docs: 2,
      complete: 3,
    };
    const curStage = op.current_stage ?? 'stage1_sign';
    const nextStage =
      (RANK.stage2_profile ?? 0) > (RANK[curStage] ?? 0) ? 'stage2_profile' : curStage;

    // Service client: no contractor write RLS
    const svc = createServiceClient();
    const { error } = await svc
      .from('onboarding_progress')
      .update({
        stage1_complete: true,
        current_stage: nextStage,
        updated_at: new Date().toISOString(),
      })
      .eq('worker_id', worker.workerId);
    if (error) return { ok: false, error: `Could not advance: ${error.message}` };

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Advance failed.'),
    };
  }
}

/** Self-complete onboarding when all required docs are approved. */
export async function finishOnboarding(): Promise<ActionResult> {
  const worker = await requireWorker();

  try {
    const db = await createServerSupabase();
    const { data: op } = await db
      .from('onboarding_progress')
      .select('stage1_complete, stage2_complete, completed_at')
      .eq('worker_id', worker.workerId)
      .maybeSingle();
    if (!op) return { ok: false, error: 'No onboarding in progress for this login.' };
    if (op.completed_at) return { ok: true, message: 'Already complete.' };
    if (!op.stage1_complete || !op.stage2_complete)
      return { ok: false, error: 'Finish your agreements and profile first.' };

    // Service client for the update + approved docs read (no contractor write RLS)
    const svc = createServiceClient();
    const { data: approved } = await svc
      .from('documents')
      .select('id, kind, side, storage_path, review_status')
      .eq('worker_id', worker.workerId)
      .in('review_status', ['approved', 'waived', 'deferred']);

    // Same predicate the admin review recompute uses, so waived/deferred clears
    // a kind consistently across both completion paths.
    const stage3Complete = isStage3Complete(approved ?? []);
    if (!stage3Complete) {
      return {
        ok: false,
        error: 'Your required documents are still being reviewed — finish once they are approved.',
      };
    }

    const now = new Date().toISOString();
    const { error } = await svc
      .from('onboarding_progress')
      .update({
        stage3_complete: true,
        completed_at: now,
        current_stage: 'complete',
        updated_at: now,
      })
      .eq('worker_id', worker.workerId);
    if (error)
      return {
        ok: false,
        error: `Could not finish onboarding: ${error.message}`,
      };

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Finish onboarding failed.'),
    };
  }
}

/* ---------- portal-sign (contractor signature) ---------- */

/**
 * Sign an agreement. Stores signature_data (data-url or typed name) in
 * onboarding_signatures.signature_data — same column the legacy edge fn used.
 */
export async function signAgreement(args: {
  agreementKey: string;
  signatureDataUrl: string;
  typedName: string;
  /** Did the signer scroll through the whole agreement? Recorded as evidence. */
  scrolledToEnd?: boolean;
}): Promise<ActionResult> {
  const worker = await requireWorker();

  const validKinds = new Set<string>(AGREEMENT_ORDER);
  if (!validKinds.has(args.agreementKey)) return { ok: false, error: 'Unknown agreement kind.' };
  // Validated above — narrow the public `string` contract to the DB enum.
  const agreementKey = args.agreementKey as AgreementKind;
  if (!args.typedName.trim()) return { ok: false, error: 'Signed legal name required.' };

  // Validate drawn signature data-url if present
  const signatureData: string | null = args.signatureDataUrl || null;
  if (signatureData) {
    const isDataUrl = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(signatureData);
    const isTypedName = !signatureData.startsWith('data:');
    if (!isDataUrl && !isTypedName) {
      return {
        ok: false,
        error: 'Signature must be a data:image URI or typed name.',
      };
    }
    if (signatureData.length > 1_000_000) return { ok: false, error: 'Signature data too large.' };
  }

  try {
    // Service client required: no contractor write policy on onboarding_signatures
    const svc = createServiceClient();

    // Enforce signing order
    const { data: preSigs } = await svc
      .from('onboarding_signatures')
      .select('agreement_kind')
      .eq('worker_id', worker.workerId)
      .eq('status', 'signed');
    const preSigned = new Set((preSigs ?? []).map((s) => s.agreement_kind));
    const order = AGREEMENT_ORDER;
    const idx = order.indexOf(agreementKey);
    for (let i = 0; i < idx; i++) {
      const prev = order[i];
      if (prev && !preSigned.has(prev)) {
        return {
          ok: false,
          error: `Sign the agreements in order — "${prev}" must be signed first.`,
        };
      }
    }

    const now = new Date().toISOString();
    const todayManila = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
    }).format(new Date());

    // Derive the method from the PLAINTEXT before encrypting (ciphertext won't
    // start with "data:"). signature_data is PHI — encrypt at rest when a key is
    // configured (no-op plaintext otherwise; see src/server/crypto).
    const signatureMethod = signatureData?.startsWith('data:') ? 'drawn' : 'typed';
    const signatureStored = signatureData ? await encryptIfConfigured(signatureData) : null;

    // Insert signature (ignore-duplicates = immutable evidence)
    const { error: insErr } = await svc.from('onboarding_signatures').upsert(
      {
        worker_id: worker.workerId,
        agreement_kind: agreementKey,
        doc_version: '1',
        signed_legal_name: args.typedName.trim(),
        signature_method: signatureMethod,
        signature_data: signatureStored,
        // Record the real value (the portal gates signing on it); default to
        // true only when an older caller omits it, to preserve prior behavior.
        scrolled_to_end: args.scrolledToEnd ?? true,
        signed_date: todayManila,
        status: 'signed',
      },
      {
        onConflict: 'worker_id,agreement_kind,doc_version',
        ignoreDuplicates: true,
      },
    );
    if (insErr)
      return {
        ok: false,
        error: `Could not record signature: ${insErr.message}`,
      };

    // Re-evaluate stage 1
    const { data: postSigs } = await svc
      .from('onboarding_signatures')
      .select('agreement_kind')
      .eq('worker_id', worker.workerId)
      .eq('status', 'signed');
    const signedNow = new Set((postSigs ?? []).map((s) => s.agreement_kind));
    const stage1Complete = order.every((k) => signedNow.has(k));

    const { data: cur } = await svc
      .from('onboarding_progress')
      .select('current_stage, completed_at')
      .eq('worker_id', worker.workerId)
      .maybeSingle();
    const RANK: Record<string, number> = {
      stage1_sign: 0,
      stage2_profile: 1,
      stage3_docs: 2,
      complete: 3,
    };
    const desired = stage1Complete ? 'stage2_profile' : 'stage1_sign';
    const curStage = cur?.current_stage ?? 'stage1_sign';
    const nextStage = cur?.completed_at
      ? curStage
      : (RANK[desired] ?? 0) > (RANK[curStage] ?? 0)
        ? desired
        : curStage;

    await svc
      .from('onboarding_progress')
      .update({
        stage1_last_kind: agreementKey,
        stage1_complete: stage1Complete,
        current_stage: nextStage,
        updated_at: now,
      })
      .eq('worker_id', worker.workerId);

    await logEvent({
      action: 'agreement.signed',
      entity: `${worker.workerId} · ${args.agreementKey}`,
      detail: {
        worker_id: worker.workerId,
        agreement_kind: args.agreementKey,
        stage1_complete: stage1Complete,
      },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Sign failed.'),
    };
  }
}

/* ---------- portal-countersign (admin) ---------- */

/**
 * Admin countersigns an agreement. Requires can_countersign flag.
 * Service client required: writes onboarding_agreements (no contractor write RLS).
 */
export async function countersignAgreement(args: {
  workerId: string;
  agreementKey: string;
  signatureDataUrl: string;
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.canCountersign)
    return {
      ok: false,
      error: 'Your admin account does not have countersign permission.',
    };

  const validKinds = new Set<string>(AGREEMENT_ORDER);
  if (!validKinds.has(args.agreementKey)) return { ok: false, error: 'Unknown agreement kind.' };
  const agreementKey = args.agreementKey as AgreementKind;

  try {
    // Service client required: countersign writes need service role (admin verified above).
    const svc = createServiceClient();

    // Contractor must have signed first
    const { data: sigs } = await svc
      .from('onboarding_signatures')
      .select('agreement_kind')
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', agreementKey)
      .eq('status', 'signed');
    if (!sigs?.length)
      return {
        ok: false,
        error: 'The contractor has not signed this agreement yet.',
      };

    // Check existing + immutability
    const { data: existing } = await svc
      .from('onboarding_agreements')
      .select('countersigned_at, countersigner_user_id, countersigner_name')
      .eq('worker_id', args.workerId)
      .eq('agreement_kind', agreementKey)
      .maybeSingle();
    if (existing?.countersigned_at)
      return { ok: false, error: 'This agreement is already countersigned.' };
    if (existing?.countersigner_user_id && existing.countersigner_user_id !== admin.userId) {
      return {
        ok: false,
        error: `Assigned to ${existing.countersigner_name ?? 'another admin'} — only the assigned countersigner may sign.`,
      };
    }

    const now = new Date().toISOString();
    const method = args.signatureDataUrl.startsWith('data:') ? 'drawn' : 'typed';
    const { error } = await svc.from('onboarding_agreements').upsert(
      {
        worker_id: args.workerId,
        agreement_kind: agreementKey,
        countersigned_by: admin.userId,
        countersigned_name: admin.name ?? admin.email,
        countersigner_user_id: admin.userId,
        countersigner_name: admin.name ?? admin.email,
        countersign_method: method,
        countersign_data: args.signatureDataUrl,
        countersigned_at: now,
        updated_at: now,
      },
      { onConflict: 'worker_id,agreement_kind' },
    );
    if (error) return { ok: false, error: `Countersign failed: ${error.message}` };

    await logEvent({
      action: 'agreement.countersigned',
      entity: `${args.workerId} · ${args.agreementKey}`,
      detail: {
        worker_id: args.workerId,
        agreement_kind: args.agreementKey,
        countersigned_name: admin.name ?? admin.email,
        method,
      },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Countersign failed.'),
    };
  }
}

/* ---------- portal-review (admin doc review) ---------- */

/**
 * Re-evaluate stage-3 (documents) completion for a worker from their
 * approved / waived / deferred docs (via the shared isStage3Complete predicate)
 * and persist it. Shared by reviewDocument and resolveMissingDocument.
 * Returns whether onboarding JUST became complete.
 */
async function recomputeStage3(
  svc: ReturnType<typeof createServiceClient>,
  workerId: string,
): Promise<{ stage3Complete: boolean; onboardingComplete: boolean }> {
  const db = await createServerSupabase();
  const [approvedDocs, progress] = await Promise.all([
    fetchApprovedDocumentsForWorker(svc, workerId),
    fetchOnboardingProgressForWorker(db, workerId),
  ]);

  const stage3Complete = isStage3Complete(approvedDocs);
  const fully = !!(progress?.stage1_complete && progress.stage2_complete && stage3Complete);
  const onboardingComplete = fully && !progress?.completed_at;
  await updateOnboardingProgressStage3(svc, workerId, stage3Complete, onboardingComplete);
  return { stage3Complete, onboardingComplete };
}

/**
 * Review a document (approve/needs_replacement/waive/defer).
 * Service client required: writes documents table (admin verified above).
 */
export async function reviewDocument(args: {
  documentId: string;
  decision: 'approve' | 'needs_replacement' | 'waive' | 'defer';
  note?: string;
}): Promise<ActionResult> {
  const admin = await requireAdmin();

  if (args.decision === 'needs_replacement' && !args.note?.trim())
    return {
      ok: false,
      error: 'A reason is required when requesting a replacement.',
    };

  try {
    // Service client required: document review writes need service role (admin verified above).
    const svc = createServiceClient();
    const now = new Date();

    const { data: doc } = await svc
      .from('documents')
      .select('id, worker_id, kind, issued_on, review_status')
      .eq('id', args.documentId)
      .maybeSingle();
    if (!doc) return { ok: false, error: 'Document not found.' };

    // NBI freshness guard on approve
    if (args.decision === 'approve' && doc.kind === 'nbi_clearance' && doc.issued_on) {
      const issued = new Date(`${doc.issued_on}T00:00:00Z`);
      const sixMonthsAfter = new Date(issued);
      sixMonthsAfter.setUTCMonth(sixMonthsAfter.getUTCMonth() + 6);
      if (sixMonthsAfter < now) {
        return {
          ok: false,
          error:
            'NBI clearance is older than 6 months — request a replacement, or confirm override.',
        };
      }
    }

    let reviewStatus: 'approved' | 'needs_replacement' | 'waived' | 'deferred';
    if (args.decision === 'approve') reviewStatus = 'approved';
    else if (args.decision === 'needs_replacement') reviewStatus = 'needs_replacement';
    else if (args.decision === 'waive') reviewStatus = 'waived';
    else reviewStatus = 'deferred';

    await updateDocumentReview(
      svc,
      args.documentId,
      reviewStatus,
      admin.userId,
      args.note?.trim() ?? null,
    );

    // Re-eval stage 3 completion (shared with resolveMissingDocument).
    const { onboardingComplete } = await recomputeStage3(svc, doc.worker_id);

    if (onboardingComplete) {
      await logEvent({
        action: 'onboarding.completed',
        entity: doc.worker_id,
        detail: { worker_id: doc.worker_id },
      });
    }

    await logEvent({
      action: `document.${reviewStatus}`,
      entity: `${doc.kind} · ${doc.worker_id}`,
      detail: {
        document_id: args.documentId,
        kind: doc.kind,
        ...(args.note ? { reason: args.note } : {}),
      },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Review failed.'),
    };
  }
}

const VALID_DOC_KINDS = new Set<string>([
  'ic_agreement',
  'w8ben',
  'gov_id',
  'other',
  'resume',
  'diploma',
  'nbi_clearance',
]);

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Waive or defer a REQUIRED document the contractor has NOT uploaded yet, from
 * the onboarding review panel. Records a fileless documents row so the
 * requirement is cleared (waive) or cleared-with-a-due-date (defer → expires_on),
 * then re-evaluates stage-3 completion. Service client after the admin check
 * (mirrors reviewDocument).
 */
export async function resolveMissingDocument(args: {
  workerId: string;
  kind: string;
  side?: string | null;
  decision: 'waive' | 'defer';
  /** Required for 'defer' — the date (YYYY-MM-DD) the doc is due by. */
  deferUntil?: string;
  note?: string;
}): Promise<ActionResult> {
  const admin = await requireAdmin();

  if (!VALID_DOC_KINDS.has(args.kind)) return { ok: false, error: 'Unknown document type.' };
  const side = args.side ?? null;

  let expiresOn: string | null = null;
  if (args.decision === 'defer') {
    const d = (args.deferUntil ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
      return { ok: false, error: 'Choose a defer-until date (YYYY-MM-DD).' };
    if (d < todayIso())
      return {
        ok: false,
        error: 'The defer-until date must be today or later.',
      };
    expiresOn = d;
  }

  try {
    // Service client after admin check — mirrors reviewDocument (storage/RLS out-of-band).
    const svc = createServiceClient();
    const reviewStatus = args.decision === 'waive' ? 'waived' : 'deferred';
    const note = args.note?.trim() || null;
    const title =
      args.decision === 'waive' ? 'Waived — no upload required' : `Deferred until ${expiresOn}`;

    await resolveMissingDocumentSlot(svc, {
      workerId: args.workerId,
      kind: args.kind as Database['public']['Enums']['document_kind'],
      side,
      reviewStatus,
      reviewedBy: admin.userId,
      reviewReason: note ?? (args.decision === 'defer' ? `Deferred until ${expiresOn}` : null),
      expiresOn,
      title,
      companyId: await getEmployerCompanyId(svc),
    });

    const { onboardingComplete } = await recomputeStage3(svc, args.workerId);
    if (onboardingComplete) {
      await logEvent({
        action: 'onboarding.completed',
        entity: args.workerId,
        detail: { worker_id: args.workerId },
      });
    }
    await logEvent({
      action: `document.${reviewStatus}`,
      entity: `${args.kind}${side ? ` (${side})` : ''} · ${args.workerId}`,
      detail: {
        kind: args.kind,
        side,
        missing: true,
        ...(expiresOn ? { deferred_until: expiresOn } : {}),
        ...(note ? { reason: note } : {}),
      },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not update the document.'),
    };
  }
}

/**
 * Revert an admin waive/defer on a not-yet-uploaded required document: deletes
 * the fileless placeholder so the slot reads MISSING again, then re-evaluates
 * stage-3 completion. Only ever removes fileless rows — never a real upload.
 */
export async function clearMissingDocumentResolution(args: {
  workerId: string;
  kind: string;
  side?: string | null;
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!VALID_DOC_KINDS.has(args.kind)) return { ok: false, error: 'Unknown document type.' };
  const side = args.side ?? null;

  try {
    const svc = createServiceClient();
    await clearFilelessDocumentSlot(
      svc,
      args.workerId,
      args.kind as Database['public']['Enums']['document_kind'],
      side,
    );
    await recomputeStage3(svc, args.workerId);
    await logEvent({
      action: 'document.resolution_cleared',
      entity: `${args.kind}${side ? ` (${side})` : ''} · ${args.workerId}`,
      detail: { kind: args.kind, side, by: admin.email },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not update the document.'),
    };
  }
}

/**
 * Set the editable signed_date on a signature (admin correction).
 * Service client required: writes onboarding_signatures (admin verified above).
 */
export async function setSignedDate(args: {
  documentId: string;
  signedDate: string;
}): Promise<ActionResult> {
  const admin = await requireAdmin();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.signedDate))
    return { ok: false, error: 'signedDate must be YYYY-MM-DD.' };

  try {
    // Interpret documentId as "worker_id:agreement_kind" for this action
    // (mirroring the legacy set_signed_date which takes worker_id + agreement_kind).
    const parts = args.documentId.split(':');
    const workerId = parts[0];
    const agreementKind = parts[1];
    if (!workerId || !agreementKind)
      return {
        ok: false,
        error: 'documentId must be "workerId:agreementKind" for setSignedDate.',
      };

    // Service client required: writes onboarding_signatures (admin verified above).
    const svc = createServiceClient();
    const { error } = await svc
      .from('onboarding_signatures')
      .update({ signed_date: args.signedDate })
      .eq('worker_id', workerId)
      .eq('agreement_kind', agreementKind as AgreementKind)
      .eq('status', 'signed');
    if (error) return { ok: false, error: `Update failed: ${error.message}` };

    await logEvent({
      action: 'signature.signed_date_set',
      entity: `${agreementKind} · ${workerId}`,
      detail: {
        worker_id: workerId,
        agreement_kind: agreementKind,
        signed_date: args.signedDate,
        by: admin.email,
      },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Set signed date failed.'),
    };
  }
}

/* ---------- portal Home: mood check-in (§10.5) ---------- */

/** Record the worker's own mood check-in. RLS mood_self_insert allows the
 * worker's own client — no service client. */
export async function saveMoodCheckin(args: {
  mood: number;
  note?: string | null;
  kind?: 'start' | 'end' | null;
}): Promise<ActionResult> {
  const worker = await requireWorker();
  const mood = Number(args.mood);
  if (!Number.isInteger(mood) || mood < 1 || mood > 5)
    return { ok: false, error: 'Pick a mood from 1 to 5.' };
  try {
    const db = await createServerSupabase();
    await insertMoodCheckin(db, worker.workerId, {
      mood,
      note: args.note?.trim() || null,
      kind: args.kind ?? null,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not save check-in.'),
    };
  }
}

/* ---------- portal Docs: signed-URL view (§10.4) ---------- */

/** Mint a 120s signed URL for the worker's OWN document (ownership re-check, then
 * service client — the contractor-docs storage policies live out-of-band). */
export async function getDocumentSignedUrl(args: {
  documentId: string;
}): Promise<ActionResult<{ url: string }>> {
  const worker = await requireWorker();
  try {
    const svc = createServiceClient();
    const { data: doc, error } = await svc
      .from('documents')
      .select('id, worker_id, kind, storage_path')
      .eq('id', args.documentId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!doc || doc.worker_id !== worker.workerId || doc.kind === 'other' || !doc.storage_path)
      return { ok: false, error: 'Document not found.' };
    const { data: signed, error: sErr } = await svc.storage
      .from('contractor-docs')
      .createSignedUrl(doc.storage_path, 120);
    if (sErr || !signed?.signedUrl)
      return { ok: false, error: sErr?.message ?? 'Could not sign URL.' };
    return { ok: true, data: { url: signed.signedUrl } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not open document.'),
    };
  }
}

/**
 * ADMIN: mint a signed URL for ANY contractor's uploaded document (for the
 * onboarding review preview). Returns a previewable `type` (image/pdf/other)
 * derived from mime/extension so the UI can render it inline. Admin-gated, then
 * service client (storage policies live out-of-band, mirroring the worker path).
 */
export async function getAdminDocumentUrl(args: {
  documentId: string;
}): Promise<ActionResult<{ url: string; name: string; type: 'image' | 'pdf' | 'other' }>> {
  const admin = await requireAdmin();
  try {
    const svc = createServiceClient();
    const { data: doc, error } = await svc
      .from('documents')
      .select('id, company_id, storage_path, title, mime_type')
      .eq('id', args.documentId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!doc?.storage_path) return { ok: false, error: 'No file to preview for this document.' };
    // Company scope: the service client bypasses RLS, so re-check ownership here.
    // Non-owner admins may only preview documents for their assigned companies
    // (mirrors the companyIds gate used across the admin actions and the
    // worker-ownership re-check in getDocumentSignedUrl). Fail closed on null.
    if (!admin.isOwner && (!doc.company_id || !admin.companyIds.includes(doc.company_id)))
      return { ok: false, error: 'Document not found.' };
    const { data: signed, error: sErr } = await svc.storage
      .from('contractor-docs')
      .createSignedUrl(doc.storage_path, 300);
    if (sErr || !signed?.signedUrl)
      return { ok: false, error: sErr?.message ?? 'Could not sign URL.' };
    const hint = `${doc.mime_type ?? ''} ${doc.title ?? ''} ${doc.storage_path}`.toLowerCase();
    const type: 'image' | 'pdf' | 'other' = /image\/|\.(png|jpe?g|webp|gif)(\?|$)/.test(hint)
      ? 'image'
      : /application\/pdf|\.pdf(\?|$)/.test(hint)
        ? 'pdf'
        : 'other';
    return {
      ok: true,
      data: { url: signed.signedUrl, name: doc.title ?? 'Document', type },
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not open document.'),
    };
  }
}

/**
 * Permanently delete a contractor document (admin Documents tab): row first,
 * then best-effort storage removal — the worst failure mode is an invisible
 * orphaned object, never a visible row whose file is gone. Fileless
 * waived/deferred placeholders delete the same way (equivalent to clearing
 * the slot resolution). Stage 3 is recomputed since deleting an approved
 * required doc can revert onboarding completion.
 */
export async function deleteContractorDocument(args: {
  documentId: string;
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const svc = createServiceClient();
    const { data: doc, error } = await svc
      .from('documents')
      .select('id, worker_id, kind, side, title, storage_path')
      .eq('id', args.documentId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!doc) return { ok: false, error: 'Document not found.' };

    // Company scope via the worker's links (same gate as the list/upload
    // actions — keys on the worker, so legacy null-company rows stay deletable
    // by owners and correctly scoped for non-owners).
    if (!admin.isOwner) {
      const db = await createServerSupabase();
      const { data: links } = await db
        .from('worker_companies')
        .select('company_id')
        .eq('worker_id', doc.worker_id);
      const inScope = (links ?? []).some((l) => admin.companyIds.includes(l.company_id));
      if (!inScope) return { ok: false, error: 'Not authorized for this contractor.' };
    }

    const del = await svc.from('documents').delete().eq('id', doc.id);
    if (del.error) return { ok: false, error: del.error.message };

    if (doc.storage_path) {
      // Best-effort: remove() of a missing path is not an error, so this is
      // idempotent; a failure only orphans a private object.
      await svc.storage.from('contractor-docs').remove([doc.storage_path]);
    }

    await recomputeStage3(svc, doc.worker_id);

    await logEvent({
      action: 'document.deleted',
      entity: `${doc.kind}${doc.side ? ` (${doc.side})` : ''} · ${doc.worker_id}`,
      detail: {
        document_id: doc.id,
        worker_id: doc.worker_id,
        kind: doc.kind,
        side: doc.side,
        title: doc.title,
        storage_path: doc.storage_path,
        by: admin.email,
      },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}

/* ---------- portal Tools: reveal (§10.6) ---------- */

/** Reveal the worker's provisioned tool credentials (get_my_tools decrypts and
 * returns {creds, popup_pending}). Persistent on shared prod — re-readable; the
 * popup is dismissed via ackMyTools (clears popup_pending), not by purging enc. */
export async function revealMyTools(): Promise<
  ActionResult<{ creds: unknown; popupPending: boolean } | null>
> {
  await requireWorker();
  try {
    const db = await createServerSupabase();
    const { data, error } = await db.rpc('get_my_tools');
    if (error) return { ok: false, error: error.message };
    if (data == null || typeof data !== 'object') return { ok: true, data: null };
    const obj = data as Record<string, unknown>;
    return {
      ok: true,
      data: {
        creds: obj.creds ?? null,
        popupPending: obj.popup_pending === true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Could not reveal tools.'),
    };
  }
}

/** Acknowledge the tools popup (clears popup_pending). */
export async function ackMyTools(): Promise<ActionResult> {
  await requireWorker();
  try {
    const db = await createServerSupabase();
    const { error } = await db.rpc('ack_my_tools');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Acknowledge failed.'),
    };
  }
}
