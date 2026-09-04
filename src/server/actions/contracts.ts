'use server';

/**
 * Contract-version actions — draft / send / void / sign / countersign
 * (docs/CONTRACT-VERSIONS-PLAN.md §3–4). Pattern: verify admin (countersign
 * permission + company scope) → Zod → service client → audit. Sign is the one
 * contractor action here (requireWorker), kept with the other status
 * transitions rather than in portal.ts.
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
import { executeRateUpsert } from '@/db/queries/rates';
import { hasPayOutstanding } from '@/db/queries/workers';
import { mergeAgreement, monthlyFromPeriod, safeSigImg } from '@/lib/agreements/merge';
import { humanizeError } from '@/lib/errors';
import { fullName } from '@/lib/names';
import { dayBefore } from '@/lib/pay/rates';
import {
  type ActionResult,
  createPortalLogin,
  restorePortalLogin,
  revokePortalLogin,
} from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { type CurrentAdmin, getCurrentAdmin } from '@/server/auth/admin';
import { requireWorker } from '@/server/auth/worker';
import { encryptIfConfigured } from '@/server/crypto';
import { portalUrl, trySend } from '@/server/email/send';
import { DEFAULT_HIRE_EMAILS, escapeHtml, mergeTemplate } from '@/server/email/templates';
import { todayManila } from '@/types/schemas/contractors';
import {
  ContractVersionRefSchema,
  DraftContractVersionSchema,
  EngagementRefSchema,
  SignContractVersionSchema,
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

/**
 * The contractor signs a sent version (decision 4): the signature row carries
 * the real version number and the sha256 of the frozen body, so the evidence
 * names exactly the text they scrolled through. Same scroll-to-end + typed
 * name / drawn image contract as signAgreement.
 *
 * A second signature is rejected, never absorbed: the status gate answers the
 * ordinary case, and the (worker, kind, doc_version) unique key answers the
 * race — this is a plain insert, not signAgreement's ignore-duplicates upsert.
 */
export async function signContractVersion(args: unknown): Promise<ActionResult> {
  const parsed = SignContractVersionSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;
  if (!input.scrolledToEnd)
    return { ok: false, error: 'Scroll through the whole agreement before signing.' };
  const drawn = input.signatureDataUrl.startsWith('data:');
  if (drawn && !safeSigImg(input.signatureDataUrl))
    return { ok: false, error: 'Signature must be a PNG/JPEG/WebP image or a typed name.' };

  try {
    const worker = await requireWorker();
    const svc = createServiceClient();
    const v = await fetchContractVersion(svc, input.versionId);
    // Someone else's version reads as "not found" — no hint that the id exists.
    if (!v || v.workerId !== worker.workerId)
      return { ok: false, error: 'Contract version not found.' };
    if (v.status === 'signed')
      return { ok: false, error: `Version ${v.version} is already signed.` };
    if (v.status !== 'sent' || !v.docSha256)
      return { ok: false, error: `Version ${v.version} is ${v.status} — nothing to sign.` };

    // ponytail: doc_version is per worker, not per engagement, so two companies
    // at the same version number would collide on the unique key. No worker has
    // two engagements today; prefix the company if that changes.
    const { error: sigErr } = await svc.from('onboarding_signatures').insert({
      worker_id: worker.workerId,
      agreement_kind: 'ic_agreement',
      doc_version: String(v.version),
      doc_sha256: v.docSha256,
      signed_legal_name: input.typedName,
      signature_method: drawn ? 'drawn' : 'typed',
      // PHI — encrypted at rest when a key is configured, like signAgreement.
      signature_data: drawn ? await encryptIfConfigured(input.signatureDataUrl) : null,
      scrolled_to_end: true,
      signed_date: todayManila(),
      status: 'signed',
    });
    if (sigErr)
      return {
        ok: false,
        error: sigErr.code === '23505' ? `Version ${v.version} is already signed.` : sigErr.message,
      };

    // Filtered on sent: if void raced the signature in, the evidence stays but
    // binds nobody — the same 'superseded' void itself would have written.
    const { data: signed, error } = await svc
      .from('contract_versions')
      .update({ status: 'signed', signed_at: new Date().toISOString() })
      .eq('id', v.id)
      .eq('status', 'sent')
      .select('id');
    if (error) throw new Error(`contract_versions sign: ${error.message}`);
    if (!signed?.length) {
      await svc
        .from('onboarding_signatures')
        .update({ status: 'superseded' })
        .eq('worker_id', worker.workerId)
        .eq('agreement_kind', 'ic_agreement')
        .eq('doc_version', String(v.version));
      return { ok: false, error: `Version ${v.version} was withdrawn — reload.` };
    }

    await logEvent({
      companyId: v.companyId,
      action: 'contract.signed',
      entity: v.workerId,
      detail: {
        version: v.version,
        version_id: v.id,
        doc_sha256: v.docSha256,
        method: drawn ? 'drawn' : 'typed',
      },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Sign failed.') };
  }
}

/**
 * Countersign a signed version — the "one unit" moment (§4). The signed IC
 * agreement, the worker_companies row and the effective-dated rate move
 * together, so this is sequential with hireContractor's rollback shape: each
 * step registers its undo, and a failure runs them in reverse.
 *
 *   1. rates: the version's amount at effective_from. The planner closes the
 *      open earlier rate the day before.
 *   2. worker_companies: contract / weekly_hours / role from the version. A
 *      rehire (link ended) reopens the link and the worker as of start_date —
 *      NOT via reactivateWorkerLink, which would reopen the old closed rate
 *      and collide with step 1. The workers trigger (migration 39) restores a
 *      still-revoked login on the way back to active.
 *   3. whatever version was active → superseded, ended the day before. An
 *      `ended` prior (rehire) keeps its real last day — the termination date is
 *      evidence, and the contractor was not under contract in between.
 *   4. this version → active + countersigned_*. Filtered on signed, so two
 *      admins clicking at once countersign once; the loser rolls back.
 *   5. email with the portal print link, audit row.
 *
 * Not here: set_tools_requested for a rehire. clearWorkerTools only wipes the
 * credentials (enc), never `requested`, so the old request is still on file
 * for the admin to fill at completion — nothing to re-request.
 */
export async function countersignContractVersion(
  args: unknown,
): Promise<ActionResult<{ emailSent: boolean; rehired: boolean }>> {
  const parsed = ContractVersionRefSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };

  const undo: (() => Promise<void>)[] = [];
  try {
    const svc = createServiceClient();
    const v = await fetchContractVersion(svc, parsed.data.versionId);
    if (!v) return { ok: false, error: 'Contract version not found.' };
    const auth = await authorize(v.companyId);
    if ('error' in auth) return auth;
    if (v.status !== 'signed')
      return {
        ok: false,
        error: `Version ${v.version} is ${v.status} — only a signed version can be countersigned.`,
      };
    // NOT NULL on the table; the shared ContractTerms type is loose for the read-through.
    const ratePhp = v.ratePhp;
    const effectiveFrom = v.effectiveFrom;
    if (ratePhp == null || !effectiveFrom || !v.startDate)
      return { ok: false, error: `Version ${v.version} is missing its rate or dates.` };

    // Everything the undo stack needs, read before the first write.
    const [link, worker, rates, login] = await Promise.all([
      svc
        .from('worker_companies')
        .select('status, started_on, ended_on, contract, weekly_hours, role')
        .eq('worker_id', v.workerId)
        .eq('company_id', v.companyId)
        .maybeSingle(),
      svc
        .from('workers')
        .select('first_name, middle_name, last_name, email, status')
        .eq('id', v.workerId)
        .maybeSingle(),
      svc
        .from('rates')
        .select('id, amount_php, effective_end')
        .eq('worker_id', v.workerId)
        .eq('company_id', v.companyId),
      svc.from('contractor_logins').select('email').eq('worker_id', v.workerId).maybeSingle(),
    ]);
    for (const r of [link, worker, rates, login])
      if (r.error) throw new Error(`countersign read: ${r.error.message}`);
    if (!link.data)
      return { ok: false, error: 'This contractor has no engagement at this company.' };
    if (!worker.data) return { ok: false, error: 'Contractor not found.' };
    const before = { link: link.data, worker: worker.data, rates: rates.data ?? [] };
    const rehire = before.link.status === 'ended';

    // 1. The rate. Money source of truth; everything else follows it.
    const rate = await executeRateUpsert(svc, {
      workerId: v.workerId,
      companyId: v.companyId,
      amountPhp: ratePhp,
      effectiveStart: effectiveFrom,
    });
    undo.push(async () => {
      // Drop what the planner inserted, put every prior row back as it was.
      const keep = new Set(before.rates.map((r) => r.id));
      const { data: now } = await svc
        .from('rates')
        .select('id')
        .eq('worker_id', v.workerId)
        .eq('company_id', v.companyId);
      for (const r of now ?? [])
        if (!keep.has(r.id)) await svc.from('rates').delete().eq('id', r.id);
      for (const r of before.rates)
        await svc
          .from('rates')
          .update({ amount_php: r.amount_php, effective_end: r.effective_end })
          .eq('id', r.id);
    });

    // 2. The engagement. The version is a full replacement (decision 12), so
    //    its terms land as they are — including a blank hours field.
    const { error: linkErr } = await svc
      .from('worker_companies')
      .update({
        contract: v.employmentType ?? before.link.contract,
        weekly_hours: v.hoursPerWeek,
        role: v.position,
        ...(rehire ? { status: 'active' as const, started_on: v.startDate, ended_on: null } : {}),
      })
      .eq('worker_id', v.workerId)
      .eq('company_id', v.companyId);
    if (linkErr) throw new Error(`worker_companies: ${linkErr.message}`);
    undo.push(async () => {
      await svc
        .from('worker_companies')
        .update({
          contract: before.link.contract,
          weekly_hours: before.link.weekly_hours,
          role: before.link.role,
          status: before.link.status,
          started_on: before.link.started_on,
          ended_on: before.link.ended_on,
        })
        .eq('worker_id', v.workerId)
        .eq('company_id', v.companyId);
    });
    if (rehire && before.worker.status !== 'active') {
      const { error: wErr } = await svc
        .from('workers')
        .update({ status: 'active' })
        .eq('id', v.workerId);
      if (wErr) throw new Error(`workers: ${wErr.message}`);
      undo.push(async () => {
        await svc.from('workers').update({ status: before.worker.status }).eq('id', v.workerId);
      });
    }

    // 3. The prior version of record, if any. Matched by status rather than
    //    supersedes_id so the one-active index can never fire at step 4.
    const endedOn = dayBefore(effectiveFrom);
    const { data: superseded, error: supErr } = await svc
      .from('contract_versions')
      .update({ status: 'superseded', ended_on: endedOn })
      .eq('worker_id', v.workerId)
      .eq('company_id', v.companyId)
      .eq('status', 'active')
      .select('id');
    if (supErr) throw new Error(`contract_versions supersede: ${supErr.message}`);
    const supersededIds = (superseded ?? []).map((r) => r.id);
    if (supersededIds.length)
      undo.push(async () => {
        await svc
          .from('contract_versions')
          .update({ status: 'active', ended_on: null })
          .in('id', supersededIds);
      });

    // 4. This version.
    const countersignedName = auth.admin.name ?? auth.admin.email;
    const { data: done, error: doneErr } = await svc
      .from('contract_versions')
      .update({
        status: 'active',
        countersigned_at: new Date().toISOString(),
        countersigned_by: auth.admin.userId,
        countersigned_name: countersignedName,
      })
      .eq('id', v.id)
      .eq('status', 'signed')
      .select('id');
    if (doneErr) throw new Error(`contract_versions countersign: ${doneErr.message}`);
    if (!done?.length) throw new Error(`Version ${v.version} changed — reload.`);

    // 5. The notice, best-effort like every other hire email; the admin is told.
    const w = before.worker;
    const name = fullName({
      firstName: w.first_name,
      middleName: w.middle_name,
      lastName: w.last_name,
    });
    const to = (login.data?.email ?? w.email ?? '').trim();
    const tpl = DEFAULT_HIRE_EMAILS.contract_countersigned;
    const vars = {
      name: escapeHtml(name),
      print_url: `${portalUrl()}/contracts/${v.id}/print`,
      version: String(v.version),
      effective_from: effectiveFrom,
    };
    const emailSent = to
      ? await trySend(
          to,
          mergeTemplate(tpl.subject, vars),
          mergeTemplate(tpl.html, vars),
          'contract_countersigned',
        )
      : false;

    await logEvent({
      companyId: v.companyId,
      action: 'contract.countersigned',
      entity: v.workerId,
      detail: {
        version: v.version,
        version_id: v.id,
        rate_php: { from: rate.priorAmountPhp, to: ratePhp },
        effective_from: effectiveFrom,
        rate_kind: rate.kind,
        rehired: rehire,
        superseded: supersededIds,
        email_sent: emailSent,
        by: auth.admin.email,
      },
    });
    revalidatePath('/contractors');
    return { ok: true, data: { emailSent, rehired: rehire } };
  } catch (err) {
    // Reverse order, best-effort — the same shape as hireContractor's rollback.
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch {
        /* keep unwinding */
      }
    }
    return { ok: false, error: humanizeError(err, 'Countersign failed.') };
  }
}
