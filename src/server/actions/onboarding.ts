'use server';

/**
 * Onboarding admin detail — fetches a single contractor's signed-agreement
 * ledger and uploaded documents for the onboarding review panel (manifest 28),
 * plus the stage overrides and the Current team chasers (Request a document /
 * Remind, docs/CONTRACT-VERSIONS-PLAN.md §7 decision 5). Admin-only; document
 * review mutations live in portal.ts (`reviewDocument`).
 */

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/db/clients/service';
import { parseOnboardingConfig } from '@/db/queries/config';
import {
  AGREEMENT_KINDS,
  fetchAgreements,
  fetchCurrentTeam,
  fetchSignatures,
} from '@/db/queries/onboarding';
import type { Database } from '@/db/types';
import { humanizeError } from '@/lib/errors';
import { owedLines } from '@/lib/onboarding/current-team';
import {
  type DocSlotStatus,
  deriveDocChecklist,
  docKindSlug,
  parseExtraDocs,
  withExtraDocs,
} from '@/lib/onboarding/documents';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { adminInScopeForWorker, requireAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { portalUrl, trySend } from '@/server/email/send';
import { DEFAULT_HIRE_EMAILS, escapeHtml, mergeTemplate } from '@/server/email/templates';

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
  /** 'signed' is the only status countersign accepts (see countersignAgreement). */
  status: Database['public']['Enums']['signature_status'];
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
    const [sigs, agrs, settingsRes, docsRes, profRes, loginRes, progRes] = await Promise.all([
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
      db
        .from('onboarding_progress')
        .select('extra_documents')
        .eq('worker_id', workerId)
        .maybeSingle(),
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
    const documentChecklist = deriveDocChecklist(
      withExtraDocs(cfg.documents, progRes.data?.extra_documents),
      documents,
    );

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
          status: s.status,
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

/**
 * Reset onboarding to stage 1 (admin override) — also the "send an existing
 * contractor back through the flow" path: re-sign the agreement packet,
 * re-confirm their profile info, top up documents.
 *
 * `completed_at` is deliberately PRESERVED: `is_onboarded()` (which RLS on the
 * contractor's own time/session rows and the portal's work tabs key on) is
 * `completed_at IS NOT NULL`, so nulling it would cut an ACTIVE contractor off
 * from logging time mid-cycle. With it kept, the portal stays fully usable and
 * the Onboarding tab reappears (current_stage ≠ 'complete') until they finish
 * again. Signed agreements and approved documents are untouched — the portal
 * only asks for what's missing.
 */
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
        updated_at: ISO_NOW(),
      })
      .eq('worker_id', args.workerId);
    if (error) return fail(error.message);
    // Contractors from before a kind existed (10 legacy signers predate the
    // non-compete) have no prefill/countersign card for it — seed missing rows
    // only, never overwriting an existing card's terms.
    const { error: agErr } = await db.from('onboarding_agreements').upsert(
      AGREEMENT_KINDS.map((kind) => ({
        worker_id: args.workerId,
        agreement_kind: kind,
        prepared_by: admin.userId,
        prepared_at: ISO_NOW(),
        updated_at: ISO_NOW(),
      })),
      { onConflict: 'worker_id,agreement_kind', ignoreDuplicates: true },
    );
    if (agErr) return fail(agErr.message);
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

// ─── Current team chasers (§7 decision 5: Request a document · Remind) ──────────

/**
 * The contractor's portal login email, or the reason there is none. Both
 * chasers land in the portal, so a contractor without an active login gets the
 * Onboard Current wizard instead (the queue hides the buttons; this is the gate).
 */
async function portalRecipient(
  workerId: string,
): Promise<{ ok: true; email: string; name: string } | { ok: false; error: string }> {
  const db = createServiceClient();
  const [{ data: login }, { data: w }] = await Promise.all([
    db.from('contractor_logins').select('email, status').eq('worker_id', workerId).maybeSingle(),
    db.from('workers').select('first_name').eq('id', workerId).maybeSingle(),
  ]);
  if (!login?.email || login.status !== 'active')
    return { ok: false, error: 'No active portal login — use Onboard current instead.' };
  return { ok: true, email: login.email, name: (w?.first_name ?? '').trim() || 'there' };
}

/**
 * Request one more document: it joins `onboarding_progress.extra_documents`
 * (so it is owed in the portal, the admin checklist and the Current team
 * queue) and the contractor is emailed. No due date (owner decision). The
 * request is recorded even when the email fails — the admin is told.
 */
export async function requestDocument(args: {
  workerId: string;
  title: string;
}): Promise<ActionResult<{ emailSent: boolean }>> {
  try {
    const admin = await requireAdmin();
    if (!(await adminInScopeForWorker(admin, args.workerId)))
      return fail('Not authorized for this contractor.');
    const title = args.title.trim().slice(0, 120);
    if (!title) return fail('Name the document.');
    const kind = docKindSlug(title);

    const to = await portalRecipient(args.workerId);
    if (!to.ok) return to;

    const db = createServiceClient();
    const { data: row, error } = await db
      .from('onboarding_progress')
      .select('extra_documents')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (error) return fail(error.message);
    // Update, never upsert: a login always comes with a progress row
    // (createPortalLogin seeds it), and inserting one here would open a fresh
    // stage-1 onboarding for a current contractor.
    if (!row) return fail('No onboarding record for this contractor.');
    const extra = parseExtraDocs(row.extra_documents);
    if (extra.some((d) => d.kind === kind))
      return fail(`"${title}" is already on their list — use Remind.`);
    const { error: upErr } = await db
      .from('onboarding_progress')
      .update({
        extra_documents: [...extra, { kind, title, required: true }].map((d) => ({
          kind: d.kind,
          title: d.title,
          required: true,
        })),
        updated_at: ISO_NOW(),
      })
      .eq('worker_id', args.workerId);
    if (upErr) return fail(upErr.message);

    const tpl = DEFAULT_HIRE_EMAILS.doc_request;
    const vars = {
      name: escapeHtml(to.name),
      doc_title: escapeHtml(title),
      portal_url: portalUrl(),
    };
    const emailSent = await trySend(
      to.email,
      mergeTemplate(tpl.subject, { ...vars, doc_title: title }), // subject is plain text
      mergeTemplate(tpl.html, vars),
      'doc_request',
    );
    await logEvent({
      action: 'document.requested',
      entity: args.workerId,
      detail: { kind, title, email_sent: emailSent, by: admin.email },
    });
    revalidatePath('/onboarding');
    return { ok: true, data: { emailSent } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Remind: one email listing everything the contractor still owes — the same
 * `owed` lines the Current team row is built from, recomputed server-side.
 */
export async function remindContractor(args: {
  workerId: string;
}): Promise<ActionResult<{ lines: number }>> {
  try {
    const admin = await requireAdmin();
    if (!(await adminInScopeForWorker(admin, args.workerId)))
      return fail('Not authorized for this contractor.');
    const companyId = await getSelectedCompanyId();
    if (!companyId) return fail('Pick a single company first.');

    // ponytail: recomputes the whole company queue to reuse the row's exact
    // rule; a per-worker loader if the roster outgrows a few dozen.
    const today = new Date().toISOString().slice(0, 10);
    const row = (await fetchCurrentTeam(createServiceClient(), companyId, today)).find(
      (r) => r.workerId === args.workerId,
    );
    const owed = owedLines(row?.items ?? []);
    if (owed.length === 0) return fail('Nothing is owed by the contractor right now.');

    const to = await portalRecipient(args.workerId);
    if (!to.ok) return to;

    const tpl = DEFAULT_HIRE_EMAILS.owed_reminder;
    const vars = {
      name: escapeHtml(to.name),
      portal_url: portalUrl(),
      owed_list: `<ul>${owed.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    };
    const sent = await trySend(
      to.email,
      mergeTemplate(tpl.subject, vars),
      mergeTemplate(tpl.html, vars),
      'owed_reminder',
    );
    if (!sent) return fail('The email could not be sent — check the audit log for details.');
    await logEvent({
      companyId,
      action: 'onboarding.reminded',
      entity: args.workerId,
      detail: { owed, by: admin.email },
    });
    return { ok: true, data: { lines: owed.length } };
  } catch (e) {
    return fail(e);
  }
}
