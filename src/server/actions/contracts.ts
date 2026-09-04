'use server';

/**
 * Contract-version actions — draft / send / void (docs/CONTRACT-VERSIONS-PLAN.md §3).
 * Pattern: verify admin (countersign permission + company scope) → Zod →
 * service client → audit. Sign lives in portal.ts (slice 3); countersign, the
 * write-through that makes a version the contract of record, is slice 4.
 *
 * Service client for every read that feeds a write: contract_versions has no
 * write policies (every write is an action), and a scoped admin's RLS view
 * would make the in-flight / prior-version decisions on a partial picture the
 * same way #82 did. The plain list read stays on the RLS client.
 */

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import {
  type ContractOfRecord,
  type ContractVersion,
  contractOfRecord,
  fetchContractVersion,
  fetchContractVersions,
} from '@/db/queries/contracts';
import { fetchAgreementTemplate } from '@/db/queries/portal';
import { hasPayOutstanding } from '@/db/queries/workers';
import { mergeAgreement, monthlyFromPeriod } from '@/lib/agreements/merge';
import { humanizeError } from '@/lib/errors';
import { fullName } from '@/lib/names';
import {
  type ActionResult,
  createPortalLogin,
  restorePortalLogin,
  revokePortalLogin,
} from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { type CurrentAdmin, getCurrentAdmin } from '@/server/auth/admin';
import { portalUrl, trySend } from '@/server/email/send';
import { DEFAULT_HIRE_EMAILS, escapeHtml, mergeTemplate } from '@/server/email/templates';
import { todayManila } from '@/types/schemas/contractors';
import {
  ContractVersionRefSchema,
  DraftContractVersionSchema,
  EngagementRefSchema,
  VoidContractVersionSchema,
} from '@/types/schemas/contracts';

const IN_FLIGHT: ReadonlySet<ContractVersion['status']> = new Set(['draft', 'sent', 'signed']);

/** Same gate as countersignAgreement, plus the usual company scope. */
const authorize = async (
  companyId: string,
): Promise<{ admin: CurrentAdmin } | { ok: false; error: string }> => {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.canCountersign)
    return { ok: false, error: 'Your admin account does not have countersign permission.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId))
    return { ok: false, error: 'No access to this company.' };
  return { admin };
};

const isoDay = (ts: string | null | undefined): string => (ts ? ts.slice(0, 10) : '');

/** The contract of record plus every versioned row, for the profile's Contracts tab. */
export async function listContractVersions(
  args: unknown,
): Promise<ActionResult<{ record: ContractOfRecord | null; versions: ContractVersion[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  const parsed = EngagementRefSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { workerId, companyId } = parsed.data;
  if (!admin.isOwner && !admin.companyIds.includes(companyId))
    return { ok: false, error: 'No access to this company.' };
  try {
    const db = await createServerSupabase();
    const [record, versions] = await Promise.all([
      contractOfRecord(db, workerId, companyId),
      fetchContractVersions(db, workerId, companyId),
    ]);
    return { ok: true, data: { record, versions } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not load contracts.') };
  }
}

/**
 * Save a draft: a new version prefilled by the caller from the contract of
 * record, or the existing draft edited in place — drafts are free (decision
 * 2), only a signed document is frozen. Refuses while a version is out for
 * signature (the one-in-flight index would too, less politely).
 */
export async function draftContractVersion(
  args: unknown,
): Promise<ActionResult<{ versionId: string; version: number }>> {
  const parsed = DraftContractVersionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;
  const auth = await authorize(input.companyId);
  if ('error' in auth) return auth;

  try {
    const svc = createServiceClient();
    const [record, versions] = await Promise.all([
      contractOfRecord(svc, input.workerId, input.companyId),
      fetchContractVersions(svc, input.workerId, input.companyId),
    ]);
    if (!record) return { ok: false, error: 'This contractor has no engagement at this company.' };
    const inFlight = versions.find((v) => IN_FLIGHT.has(v.status));
    if (inFlight && inFlight.status !== 'draft')
      return {
        ok: false,
        error: `Version ${inFlight.version} is already out for signature — void it first.`,
      };

    const terms = {
      rate_php: input.ratePhp,
      position: input.position?.trim() || null,
      employment_type: input.employmentType,
      schedule: input.schedule?.trim() || null,
      hours_per_week: input.hoursPerWeek,
      start_date: input.startDate,
      effective_from: input.effectiveFrom,
      addendum_type: input.addendumType || null,
      addendum_text: input.addendumText?.trim() || null,
    };

    let versionId: string;
    let version: number;
    if (inFlight) {
      const { error } = await svc
        .from('contract_versions')
        .update(terms)
        .eq('id', inFlight.id)
        .eq('status', 'draft');
      if (error) throw new Error(`contract_versions update: ${error.message}`);
      versionId = inFlight.id;
      version = inFlight.version;
    } else {
      // Rows start at 2 — version 1 is the read-through of the legacy row
      // (decision 4). The document names the version it supersedes: the one of
      // record, else the one termination ended (a rehire), else nothing, because
      // the v1 read-through has no row to point at.
      const prior =
        versions.find((v) => v.status === 'active') ?? versions.find((v) => v.status === 'ended');
      version = Math.max(1, ...versions.map((v) => v.version)) + 1;
      const { data, error } = await svc
        .from('contract_versions')
        .insert({
          worker_id: input.workerId,
          company_id: input.companyId,
          version,
          status: 'draft',
          ...terms,
          supersedes_id: prior?.id ?? null,
          created_by: auth.admin.userId,
        })
        .select('id')
        .single();
      if (error) throw new Error(`contract_versions insert: ${error.message}`);
      versionId = data.id;
    }

    await logEvent({
      companyId: input.companyId,
      action: 'contract.drafted',
      entity: input.workerId,
      detail: {
        version,
        version_id: versionId,
        rate_php: input.ratePhp,
        effective_from: input.effectiveFrom,
        edited: !!inFlight,
        by: auth.admin.email,
      },
    });
    return { ok: true, data: { versionId, version } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not save the draft.') };
  }
}

/**
 * Send a draft for signature (decision 6): freeze the rendered body and its
 * sha256, make sure the contractor can sign in (create a login, or restore the
 * one the sunset sweep revoked — the engagement itself stays ended until
 * countersign), email the notice, mark it sent.
 */
export async function sendContractVersion(
  args: unknown,
): Promise<ActionResult<{ emailSent: boolean; login: 'active' | 'restored' | 'created' }>> {
  const parsed = ContractVersionRefSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };

  try {
    const svc = createServiceClient();
    const v = await fetchContractVersion(svc, parsed.data.versionId);
    if (!v) return { ok: false, error: 'Contract version not found.' };
    const auth = await authorize(v.companyId);
    if ('error' in auth) return auth;
    if (v.status !== 'draft')
      return {
        ok: false,
        error: `Version ${v.version} is ${v.status} — only a draft can be sent.`,
      };

    // 1. Freeze the document: today's template merged with the version's terms,
    //    plus the one merge line every version carries (decision 12). The
    //    superseded date is when the prior agreement was signed; the v1
    //    read-through may have no signature at all, and then there is nothing
    //    to supersede.
    const [template, worker, company, legacy, prior] = await Promise.all([
      fetchAgreementTemplate(svc, 'ic_agreement'),
      svc
        .from('workers')
        .select('first_name, middle_name, last_name, email, ph_address')
        .eq('id', v.workerId)
        .maybeSingle(),
      svc.from('companies').select('name').eq('id', v.companyId).maybeSingle(),
      svc
        .from('onboarding_agreements')
        .select('countersigner_name')
        .eq('worker_id', v.workerId)
        .eq('agreement_kind', 'ic_agreement')
        .maybeSingle(),
      v.supersedesId
        ? fetchContractVersion(svc, v.supersedesId)
        : contractOfRecord(svc, v.workerId, v.companyId),
    ]);
    if (!template) return { ok: false, error: 'No IC agreement template is configured.' };
    if (worker.error) throw new Error(`workers: ${worker.error.message}`);
    if (!worker.data) return { ok: false, error: 'Contractor not found.' };
    const w = worker.data;
    const name = fullName({
      firstName: w.first_name,
      middleName: w.middle_name,
      lastName: w.last_name,
    });
    // NOT NULL on the table; the shared ContractTerms type is loose for the read-through.
    const effectiveFrom = v.effectiveFrom ?? '';
    const supersededOn = prior ? isoDay(prior.signedAt) || isoDay(prior.countersignedAt) : '';
    const mergeLine = supersededOn
      ? `This Agreement takes effect on ${effectiveFrom} and supersedes the Independent Contractor Agreement dated ${supersededOn}.`
      : `This Agreement takes effect on ${effectiveFrom}.`;
    const basis = v.periodBasis === 'semi_monthly' ? 'semi-monthly period' : v.periodBasis;
    const body = mergeAgreement(template.body, {
      contractor_name: name,
      rate: `${(v.ratePhp ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} per ${basis}`,
      monthly_rate: monthlyFromPeriod(v.ratePhp),
      company_name: company.data?.name,
      start_date: v.startDate,
      position: v.position,
      countersigner_name: legacy.data?.countersigner_name,
      contractor_address: w.ph_address,
      // Same mapping hireContractor uses for the legacy prefill.
      employment_type:
        v.employmentType === 'PT' ? 'part_time' : v.employmentType ? 'full_time' : '',
      hours_per_week: v.hoursPerWeek,
      schedule: v.schedule,
      today: todayManila(),
      addendum: [v.addendumText, mergeLine].filter(Boolean).join('\n\n'),
    });
    const sha = createHash('sha256').update(body).digest('hex');

    // 2. A login they can sign with. The sunset sweep skips sent/signed
    //    versions, so a restored login survives the night (slice 1).
    const { data: login, error: loginErr } = await svc
      .from('contractor_logins')
      .select('email, status')
      .eq('worker_id', v.workerId)
      .maybeSingle();
    if (loginErr) throw new Error(`contractor_logins: ${loginErr.message}`);
    let loginState: 'active' | 'restored' | 'created';
    let to = login?.email ?? w.email ?? '';
    if (!login) {
      to = (w.email ?? '').trim();
      if (!to)
        return {
          ok: false,
          error: 'Set a personal email on the profile first — the contractor signs in the portal.',
        };
      const created = await createPortalLogin({ workerId: v.workerId, email: to });
      if (!created.ok) return { ok: false, error: created.error };
      loginState = 'created';
    } else if (login.status !== 'active') {
      const restored = await restorePortalLogin({ workerId: v.workerId });
      if (!restored.ok) return { ok: false, error: restored.error };
      loginState = 'restored';
    } else {
      loginState = 'active';
    }

    // 3. Sent. Filtered on draft so two admins clicking at once send once.
    const { data: sent, error: sendErr } = await svc
      .from('contract_versions')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        rendered_body: body,
        doc_sha256: sha,
      })
      .eq('id', v.id)
      .eq('status', 'draft')
      .select('id');
    if (sendErr) throw new Error(`contract_versions send: ${sendErr.message}`);
    if (!sent?.length) return { ok: false, error: `Version ${v.version} was already sent.` };

    // 4. The notice. Best-effort like every other hire email; the admin is told.
    const tpl = DEFAULT_HIRE_EMAILS.contract_review;
    const vars = {
      name: escapeHtml(name),
      portal_url: portalUrl(),
      version: String(v.version),
      effective_from: effectiveFrom,
    };
    const emailSent = to
      ? await trySend(
          to,
          mergeTemplate(tpl.subject, vars),
          mergeTemplate(tpl.html, vars),
          'contract_review',
        )
      : false;

    await logEvent({
      companyId: v.companyId,
      action: 'contract.sent',
      entity: v.workerId,
      detail: {
        version: v.version,
        version_id: v.id,
        doc_sha256: sha,
        login: loginState,
        email_sent: emailSent,
        by: auth.admin.email,
      },
    });
    revalidatePath('/contractors');
    return { ok: true, data: { emailSent, login: loginState } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not send the contract.') };
  }
}

/**
 * Void a draft / sent / signed version (decision 9: admin-only, no contractor
 * decline). A signature on it becomes 'superseded' — evidence of a document
 * nobody is bound by. The versions of record (active/superseded/ended) are
 * history and cannot be voided.
 */
export async function voidContractVersion(
  args: unknown,
): Promise<ActionResult<{ loginRevoked: boolean }>> {
  const parsed = VoidContractVersionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };

  try {
    const svc = createServiceClient();
    const v = await fetchContractVersion(svc, parsed.data.versionId);
    if (!v) return { ok: false, error: 'Contract version not found.' };
    const auth = await authorize(v.companyId);
    if ('error' in auth) return auth;
    if (!IN_FLIGHT.has(v.status))
      return { ok: false, error: `Version ${v.version} is ${v.status} and cannot be voided.` };

    const { data: voided, error } = await svc
      .from('contract_versions')
      .update({
        status: 'void',
        voided_at: new Date().toISOString(),
        void_reason: parsed.data.reason?.trim() || null,
      })
      .eq('id', v.id)
      .in('status', [...IN_FLIGHT])
      .select('id');
    if (error) throw new Error(`contract_versions void: ${error.message}`);
    if (!voided?.length) return { ok: false, error: `Version ${v.version} changed — reload.` };

    if (v.status === 'signed') {
      // The evidence trigger allows exactly this edit (status), nothing else.
      const { error: sigErr } = await svc
        .from('onboarding_signatures')
        .update({ status: 'superseded' })
        .eq('worker_id', v.workerId)
        .eq('agreement_kind', 'ic_agreement')
        .eq('doc_version', String(v.version))
        .eq('status', 'signed');
      if (sigErr) throw new Error(`onboarding_signatures: ${sigErr.message}`);
    }

    // Send restored a departed contractor's login so they could sign; void hands
    // it straight back to the sunset rule instead of waiting for tonight's tick.
    // ponytail: same predicate as sunsetPortalLogins (ended + fully paid) rather
    // than remembering whether send did the restoring — a login an admin restored
    // by hand for a fully-paid departure would go tonight anyway. A draft never
    // touched the login.
    let loginRevoked = false;
    if (v.status !== 'draft') {
      const { data: w } = await svc
        .from('workers')
        .select('status')
        .eq('id', v.workerId)
        .maybeSingle();
      if (w?.status === 'ended' && !(await hasPayOutstanding(svc, v.workerId))) {
        const { data: login } = await svc
          .from('contractor_logins')
          .select('status')
          .eq('worker_id', v.workerId)
          .maybeSingle();
        if (login?.status === 'active')
          loginRevoked = (await revokePortalLogin({ workerId: v.workerId })).ok;
      }
    }

    await logEvent({
      companyId: v.companyId,
      action: 'contract.voided',
      entity: v.workerId,
      detail: {
        version: v.version,
        version_id: v.id,
        was: v.status,
        reason: parsed.data.reason?.trim() || null,
        login_revoked: loginRevoked,
        by: auth.admin.email,
      },
    });
    revalidatePath('/contractors');
    return { ok: true, data: { loginRevoked } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Could not void the contract.') };
  }
}
