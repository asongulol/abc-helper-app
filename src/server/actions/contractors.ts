'use server';

/**
 * Contractor server actions — add_contractor, edit_contractor.
 * Pattern: verify admin → company scope check → Zod validate → query module →
 * audit log. No inline SQL, no money math.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { type ClientOption, fetchActiveClients } from '@/db/queries/invoicing';
import {
  AGREEMENT_KINDS,
  type DerivedAgreementPrefill,
  deriveAgreementPrefill,
} from '@/db/queries/onboarding';
import {
  clearWorkerTools,
  endEngagement,
  fetchWorkerLinks,
  insertWorkerWithLink,
  reactivateWorkerLink,
  setWorkerStatus,
  updateWorkerLink,
  updateWorkerProfile,
} from '@/db/queries/workers';
import type { Json } from '@/db/types';
import { humanizeError } from '@/lib/errors';
import { saveRate } from '@/server/actions/payroll';
import { type ActionResult, createPortalLogin } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  AddContractorSchema,
  EndAssignmentSchema,
  HireContractorSchema,
  OnboardCurrentSchema,
  SaveWorkerCompanyLinkSchema,
  SaveWorkerProfileSchema,
  SetLinkStatusSchema,
  TerminateContractorSchema,
} from '@/types/schemas/contractors';

/** Quick-add a blank contractor and link them to the selected company. */
export async function addContractor(args: unknown): Promise<ActionResult<{ workerId: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddContractorSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const workerId = await insertWorkerWithLink(db, {
      firstName: input.firstName,
      lastName: input.lastName,
      companyId: input.companyId,
      contract: input.contract,
      payBasis: input.payBasis,
    });
    // Set hubstaff_name on the link if provided (e.g. from CSV import unmatched name).
    if (input.hubstaffName) {
      await updateWorkerLink(db, workerId, input.companyId, {
        contract: input.contract,
        pay_basis: input.payBasis,
        role: null,
        hubstaff_name: input.hubstaffName,
        weekly_hours: null,
        status: 'active',
      });
    }
    await logEvent({
      companyId: input.companyId,
      action: 'add_contractor',
      entity: `${input.firstName} ${input.lastName}`.trim(),
      detail: input.hubstaffName
        ? { from: 'csv_import', hubstaff_name: input.hubstaffName }
        : { from: 'contractors tab' },
    });
    return { ok: true, data: { workerId } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Create failed.'),
    };
  }
}

/** Save profile + link fields for an existing contractor. */
export async function saveWorkerProfile(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SaveWorkerProfileSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();

    // About / culture lives in workers.profile_extras (jsonb) — merge so we don't
    // clobber portal-set keys (nickname, hobbies, …). Mirrors updateOwnProfile.
    const { data: cur } = await db
      .from('workers')
      .select('profile_extras')
      .eq('id', input.workerId)
      .maybeSingle();
    const extras: Record<string, unknown> =
      cur?.profile_extras && typeof cur.profile_extras === 'object'
        ? { ...(cur.profile_extras as Record<string, unknown>) }
        : {};
    for (const [k, v] of [
      ['favorite_color', input.favoriteColor],
      ['favorite_food', input.favoriteFood],
      ['motto', input.motto],
    ] as const) {
      if (v === undefined) continue; // field not submitted — leave as-is
      if (v === null || v === '') delete extras[k];
      else extras[k] = v;
    }

    await updateWorkerProfile(db, input.workerId, {
      first_name: input.firstName,
      middle_name: input.middleName,
      last_name: input.lastName,
      email: input.email,
      mobile: input.mobile,
      hire_date: input.hireDate,
      ph_address: input.phAddress,
      permanent_address: input.permanentAddress,
      address_landmark: input.addressLandmark,
      postal_code: input.postalCode,
      payout_method: input.payoutMethod,
      health_allowance_eligible: input.healthAllowanceEligible,
      thirteenth_month_eligible: input.thirteenthMonthEligible,
      work_email: input.workEmail ?? null,
      work_number: input.workNumber ?? null,
      work_extension: input.workExtension ?? null,
      shift_start: input.shiftStart ?? null,
      shift_end: input.shiftEnd ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      emergency_name: input.emergencyName ?? null,
      emergency_relationship: input.emergencyRelationship ?? null,
      emergency_mobile: input.emergencyMobile ?? null,
      marital_status: input.maritalStatus ?? null,
      education_level: input.educationLevel ?? null,
      course: input.course ?? null,
      year_graduated: input.yearGraduated ?? null,
      school: input.school ?? null,
      gcash: input.gcash ?? null,
      paymaya: input.paymaya ?? null,
      paypal: input.paypal ?? null,
      wise_tag: input.wiseTag ?? null,
      profile_extras: extras as Json,
    });
    await updateWorkerLink(db, input.workerId, input.companyId, {
      contract: input.contract,
      pay_basis: input.payBasis,
      role: input.role,
      hubstaff_name: input.hubstaffName,
      weekly_hours: input.weeklyHours,
      bill_rate_usd: input.billRateUsd ?? null,
      session_rate_usd: input.sessionRateUsd ?? null,
      // Absent for an ended link — the form has no say over a departure.
      ...(input.linkStatus ? { status: input.linkStatus } : {}),
    });
    await logEvent({
      companyId: input.companyId,
      action: 'edit_contractor',
      entity: `${input.firstName} ${input.lastName}`.trim(),
      detail: { worker_id: input.workerId },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Save failed.'),
    };
  }
}

/** Reactivate a contractor's company link. Ending one goes elsewhere — below. */
export async function setContractorLinkStatus(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SetLinkStatusSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  // Reactivation only. Ending an engagement has to close rates and coverage
  // targets too, so it goes through terminateContractor / endAssignment — a
  // second path that writes status='ended' and nothing else is what left 6
  // ended workers sitting on active links (#79).
  if (!input.active) {
    return { ok: false, error: 'Use Terminate or End assignment to end an engagement.' };
  }

  try {
    const db = await createServerSupabase();
    await reactivateWorkerLink(db, input.workerId, input.companyId);
    await logEvent({
      companyId: input.companyId,
      action: 'edit_contractor',
      entity: input.workerId,
      detail: { status: 'active' },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Status update failed.'),
    };
  }
}

/**
 * Terminate a contractor — they have left, so EVERY engagement ends as of
 * `lastDay`, rates and coverage targets close, and stored tool credentials are
 * wiped.
 *
 * Deliberately does NOT touch the portal login: access is kept until their
 * final pay lands (owner decision), which is derived at sign-in rather than
 * revoked here. Nor does it block or alter payment — time already worked is
 * still payable, immediately via an off-cycle batch or on the next scheduled
 * period. Ending an engagement is not the same as closing the books on it.
 */
export async function terminateContractor(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = TerminateContractorSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  try {
    const db = await createServerSupabase();
    const svc = createServiceClient();

    // This ends links at EVERY company, so a company-scoped admin needs access
    // to all of them — the per-company check the other actions do, widened to
    // match the blast radius. Read on the SERVICE client: through RLS the list
    // is a subset of admin.companyIds by construction and the guard below can
    // never fire (#82).
    const links = await fetchWorkerLinks(svc, input.workerId);
    const companyIds = links.map((l) => l.companyId);
    if (!admin.isOwner && companyIds.some((id) => !admin.companyIds.includes(id))) {
      return {
        ok: false,
        error: 'This contractor is assigned to a company you cannot access — ask an owner.',
      };
    }

    // Already terminated: endEngagement skips ended links and setWorkerStatus
    // refuses an ended row, so everything below is a no-op — an `ok` would only
    // add an audit row claiming a last day nothing wrote. Refuse like
    // endAssignment does. Read on the service client, same reason as the links.
    // NB: this is the WORKER's status, not the links' — someone between
    // assignments has every link ended while `workers.status` is 'inactive', and
    // terminating them is exactly the path #95A asked for.
    const { data: worker } = await svc
      .from('workers')
      .select('status')
      .eq('id', input.workerId)
      .maybeSingle();
    if (worker?.status === 'ended') {
      return { ok: false, error: 'That contractor has already been terminated.' };
    }

    await endEngagement(db, {
      workerId: input.workerId,
      companyId: null,
      lastDay: input.lastDay,
    });
    await setWorkerStatus(db, input.workerId, 'ended');
    // Service client: worker_tools holds encrypted credentials and denies the
    // admin role, same reason withdrawOffer reaches for it.
    await clearWorkerTools(svc, input.workerId);

    await logEvent({
      // audit_log's INSERT policy is `is_company_admin(company_id)`, and
      // is_company_admin(NULL) collapses to is_owner() — so a NULL here silently
      // dropped the row for exactly the scoped admins whose terminations most
      // need a trail (#93). A termination spans every company; `detail.companies`
      // carries the span, this just has to name one the admin can see.
      // ponytail: first link wins. One row per company if audit ever needs
      // per-company retrieval of this action.
      companyId: companyIds[0] ?? null,
      action: 'contractor.terminated',
      entity: input.workerId,
      detail: {
        last_day: input.lastDay,
        ...(input.reason ? { reason: input.reason } : {}),
        companies: companyIds.length,
        by: admin.email,
      },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Termination failed.') };
  }
}

/**
 * End ONE company assignment as of `lastDay`. The contractor stays on the
 * roster: if this was their last active link they become `inactive` — between
 * assignments, still willing to work — never `ended`. Only `terminateContractor`
 * ends someone.
 */
export async function endAssignment(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = EndAssignmentSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const { endedCompanyIds } = await endEngagement(db, {
      workerId: input.workerId,
      companyId: input.companyId,
      lastDay: input.lastDay,
    });
    // Nothing was open to end — a stale tab clicking "End…" on an assignment
    // that already ended. Say so instead of re-running the tail below, which is
    // how a terminated contractor got dropped back to 'inactive' (#88).
    if (endedCompanyIds.length === 0) {
      return { ok: false, error: 'That assignment has already ended.' };
    }

    // Global count on the SERVICE client. Through RLS this sees only the calling
    // admin's companies, so a worker still active at a company they cannot see
    // counted as zero and went 'inactive' everywhere — zeroing their health
    // allowance and 13th-month at the company still employing them (#83).
    const remainingActive = (await fetchWorkerLinks(createServiceClient(), input.workerId)).filter(
      (l) => l.status === 'active',
    ).length;
    if (remainingActive === 0) await setWorkerStatus(db, input.workerId, 'inactive');

    await logEvent({
      companyId: input.companyId,
      action: 'assignment.ended',
      entity: input.workerId,
      detail: {
        last_day: input.lastDay,
        ...(input.reason ? { reason: input.reason } : {}),
        remaining_active: remainingActive,
        by: admin.email,
      },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Ending the assignment failed.') };
  }
}

/** Slugify an extra-document title to a stable kind key (legacy ocSlug). */
const docSlug = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'item';

/** Dedupe extra-doc kinds, suffixing collisions (legacy ocUniq). */
const uniqueDocs = (
  items: Array<{ kind: string; title: string; required: boolean }>,
): Array<{ kind: string; title: string; required: boolean }> => {
  const seen: Record<string, number> = {};
  return items.map((o) => {
    let k = o.kind || 'item';
    if (seen[k]) {
      let n = 2;
      while (seen[`${k}_${n}`]) n++;
      k = `${k}_${n}`;
    }
    seen[k] = 1;
    return { ...o, kind: k };
  });
};

/**
 * Transactional hire orchestrator — the Add Contractor Wizard's "Create
 * contractor" target. Faithful port of the legacy `AddContractorWizard.create()`:
 *
 * Ordered writes (stop on first error): workers → worker_companies link →
 * rates (only if rate > 0) → portal login (only if invite). On ANY throw before
 * success the just-created `workers` row is deleted — FK `ON DELETE CASCADE`
 * clears its link / rate / login / onboarding rows. A best-effort per-hire prep
 * block (agreement prefill, extra-document request, tools-requested) runs after
 * the core writes in its own try/catch and is EXCLUDED from the rollback.
 *
 * Returns the new worker id and (when invited) the temp portal password.
 */
/** Active client companies (admin-scoped) for the hire wizard's invoice picker. */
export async function listInvoiceClients(): Promise<ActionResult<ClientOption[]>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const db = await createServerSupabase();
    const clients = await fetchActiveClients(db);
    const scoped = admin.isOwner ? clients : clients.filter((c) => admin.companyIds.includes(c.id));
    return { ok: true, data: scoped };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Failed to load clients.') };
  }
}

export async function hireContractor(
  args: unknown,
): Promise<ActionResult<{ workerId: string; tempPassword?: string; emailSent?: boolean }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = HireContractorSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  if (
    input.invoiceClientId &&
    !admin.isOwner &&
    !admin.companyIds.includes(input.invoiceClientId)
  ) {
    return { ok: false, error: 'No access to the selected invoicing client.' };
  }
  if (input.invite && !input.email) {
    return {
      ok: false,
      error: 'A personal email is required to invite to the portal.',
    };
  }

  const db = await createServerSupabase();

  // --- Duplicate prevention (in order): email vs workers, email vs logins, then
  // a name soft-warn the caller must clear via allowDuplicateName. ---
  if (input.email) {
    const { data: dupe } = await db
      .from('workers')
      .select('id, first_name, last_name')
      .ilike('email', input.email)
      .limit(1);
    if (dupe && dupe.length > 0) {
      const who = [dupe[0]?.first_name, dupe[0]?.last_name].filter(Boolean).join(' ') || 'Someone';
      return {
        ok: false,
        error: `${who} already uses ${input.email} — open their profile instead.`,
      };
    }
    const { data: loginDupe } = await db
      .from('contractor_logins')
      .select('worker_id')
      .ilike('email', input.email)
      .limit(1);
    if (loginDupe && loginDupe.length > 0) {
      return {
        ok: false,
        error: `${input.email} is already in use by another portal login — use a different email.`,
      };
    }
  }
  if (!input.allowDuplicateName) {
    const norm = (s: string | null | undefined) =>
      String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    const { data: nameDupe } = await db
      .from('workers')
      .select('first_name, middle_name, last_name, email, status')
      .ilike('first_name', input.firstName)
      .ilike('last_name', input.lastName)
      .limit(5);
    const hit = (nameDupe ?? []).find(
      (d) =>
        norm(d.first_name) === norm(input.firstName) && norm(d.last_name) === norm(input.lastName),
    );
    if (hit) {
      const who = [hit.first_name, hit.middle_name, hit.last_name].filter(Boolean).join(' ');
      return {
        ok: false,
        error: `DUPLICATE_NAME: A contractor named ${who}${hit.email ? ` (${hit.email})` : ''} already exists${hit.status && hit.status !== 'active' ? ` — currently ${hit.status}` : ''}.`,
      };
    }
  }

  let workerId: string | null = null;
  try {
    // 1) workers + worker_companies link (minimal), via the shared insert.
    workerId = await insertWorkerWithLink(db, {
      firstName: input.firstName,
      lastName: input.lastName,
      companyId: input.companyId,
      contract: input.contract,
      payBasis: input.payBasis,
    });

    // 2) Fill the rest of the worker profile (covers email/addresses/eligibility).
    await updateWorkerProfile(db, workerId, {
      first_name: input.firstName,
      middle_name: input.middleName,
      last_name: input.lastName,
      email: input.email,
      mobile: null,
      hire_date: input.hireDate,
      ph_address: input.phAddress,
      permanent_address: input.permanentAddress,
      address_landmark: null,
      postal_code: null,
      payout_method: null,
      health_allowance_eligible: input.healthAllowanceEligible,
      thirteenth_month_eligible: input.thirteenthMonthEligible,
    });

    // Fields not covered by updateWorkerProfile (DOB + daily shift, PHT).
    {
      const { error: extraErr } = await db
        .from('workers')
        .update({
          date_of_birth: input.dateOfBirth,
          shift_start: input.shiftStart,
          shift_end: input.shiftEnd,
        })
        .eq('id', workerId);
      if (extraErr) throw new Error(`workers extra fields: ${extraErr.message}`);
    }

    // 3) Link engagement fields: role, weekly_hours, started_on=hire_date.
    await updateWorkerLink(db, workerId, input.companyId, {
      contract: input.contract,
      pay_basis: input.payBasis,
      role: input.role,
      hubstaff_name: null,
      weekly_hours: input.weeklyHours,
      status: 'active',
    });
    {
      const { error: startErr } = await db
        .from('worker_companies')
        .update({ started_on: input.hireDate })
        .eq('worker_id', workerId)
        .eq('company_id', input.companyId);
      if (startErr) throw new Error(`worker_companies started_on: ${startErr.message}`);
    }

    // 4) Rate (only if > 0). Reuse the effective-dated saveRate action.
    if (input.ratePhp > 0) {
      const rateRes = await saveRate({
        workerId,
        companyId: input.companyId,
        amountPhp: input.ratePhp,
        effectiveStart: input.contractDate ?? input.hireDate,
      });
      if (!rateRes.ok) throw new Error(rateRes.error);
    }

    // 4b) Optional client-invoicing link: assign the provider to a CLIENT and
    // carry the USD bill rate (+ a session rate when per-session is on) on that
    // client's worker_companies link. Upsert so picking the already-linked
    // company just sets the rates. Bill/session rates are client-side, separate
    // from the (employer) PHP pay rate above.
    if (input.invoiceClientId) {
      const { data: client } = await db
        .from('companies')
        .select('kind')
        .eq('id', input.invoiceClientId)
        .maybeSingle();
      if (client?.kind !== 'client')
        throw new Error('The invoicing target must be a client company.');
      const { error: linkErr } = await db.from('worker_companies').upsert(
        {
          worker_id: workerId,
          company_id: input.invoiceClientId,
          contract: input.contract,
          pay_basis: input.payBasis,
          role: input.role,
          status: 'active',
          bill_rate_usd: input.billRateUsd,
          session_rate_usd: input.perSession ? input.sessionRateUsd : null,
        },
        { onConflict: 'worker_id,company_id' },
      );
      if (linkErr) throw new Error(`client invoicing link: ${linkErr.message}`);
    }

    // 5) Portal login (only if invite). The edge create_login is the
    // authoritative duplicate-email guard (it can see ALL auth accounts).
    let tempPassword: string | undefined;
    let emailSent = false;
    if (input.invite && input.email) {
      const loginRes = await createPortalLogin({
        workerId,
        email: input.email,
      });
      if (!loginRes.ok) throw new Error(loginRes.error);
      tempPassword = loginRes.data.tempPassword;
      emailSent = loginRes.data.emailSent ?? false;
    }

    // --- Best-effort per-hire prep (own try/catch, EXCLUDED from rollback) ---
    try {
      const empType = input.contract === 'PT' ? 'part_time' : 'full_time';
      const csId = input.countersignerUserId;
      const csName = input.countersignerName?.trim() || null;
      const now = new Date().toISOString();

      // Snapshot the company name for {{company_name}} on the agreements.
      const { data: co } = await db
        .from('companies')
        .select('name')
        .eq('id', input.companyId)
        .maybeSingle();
      const coName = co?.name ?? null;

      // Prefill the IC Agreement (rate / position / start + addendum).
      await db.from('onboarding_agreements').upsert(
        {
          worker_id: workerId,
          agreement_kind: 'ic_agreement',
          f_rate: input.ratePhp > 0 ? String(input.ratePhp) : null,
          f_position: input.role,
          f_start_date: input.hireDate,
          f_company_name: coName,
          f_employment_type: empType,
          f_hours_per_week: input.weeklyHours,
          f_schedule: input.shiftLabel,
          addendum_type: input.icAddendumType || null,
          addendum_text: input.icAddendumText?.trim() || null,
          countersigner_user_id: csId,
          countersigner_name: csName,
          prepared_by: admin.userId,
          prepared_at: now,
          updated_at: now,
        },
        { onConflict: 'worker_id,agreement_kind' },
      );

      // Same countersigner + company + engagement basis on the other agreements
      // so none show a blank line.
      if (csId || csName || coName || input.weeklyHours || input.shiftLabel) {
        for (const k of AGREEMENT_KINDS) {
          if (k === 'ic_agreement') continue;
          await db.from('onboarding_agreements').upsert(
            {
              worker_id: workerId,
              agreement_kind: k,
              countersigner_user_id: csId,
              countersigner_name: csName,
              f_company_name: coName,
              f_employment_type: empType,
              f_hours_per_week: input.weeklyHours,
              f_schedule: input.shiftLabel,
              prepared_by: admin.userId,
              prepared_at: now,
              updated_at: now,
            },
            { onConflict: 'worker_id,agreement_kind' },
          );
        }
      }

      // Record any extra documents to request (only meaningful when inviting).
      const xdocs = uniqueDocs(
        input.extraDocs
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => ({ kind: docSlug(t), title: t, required: true })),
      );
      if (input.invite && xdocs.length > 0) {
        await db
          .from('onboarding_progress')
          .upsert(
            { worker_id: workerId, extra_documents: xdocs, updated_at: now },
            { onConflict: 'worker_id' },
          );
      }

      // Record which tools to provision (logins entered at completion). The
      // SECURITY DEFINER RPC requires the service client.
      const tr = input.tools;
      if (
        input.invite &&
        (tr.gmail || tr.providersoft || tr.hubstaff || tr.zoom || tr.others.trim())
      ) {
        const svc = createServiceClient();
        await svc.rpc('set_tools_requested', {
          p_worker_id: workerId,
          p_requested: tr as unknown as Json,
        });
      }
    } catch {
      /* non-fatal: the contractor is already created/invited */
    }

    await logEvent({
      companyId: input.companyId,
      action: 'add_contractor',
      entity: `${input.firstName} ${input.lastName}`.trim(),
      detail: {
        from: 'wizard',
        contract: input.contract,
        invited: input.invite,
        rate: input.ratePhp > 0 ? input.ratePhp : null,
        addendum: input.icAddendumType || null,
        extra_docs: input.extraDocs.filter((t) => t.trim()).length,
      },
    });

    revalidatePath('/contractors');
    return tempPassword !== undefined
      ? { ok: true, data: { workerId, tempPassword, emailSent } }
      : { ok: true, data: { workerId } };
  } catch (err) {
    // ROLLBACK: delete the just-created worker (FK cascades clear the rest).
    if (workerId) {
      try {
        const svc = createServiceClient();
        await svc.from('workers').delete().eq('id', workerId);
      } catch {
        /* best-effort cleanup */
      }
    }
    return {
      ok: false,
      error: humanizeError(err, 'Hire failed.'),
    };
  }
}

/**
 * Persist a contractor photo path (object already uploaded to the `avatars`
 * bucket client-side, which the avatar RLS allows for admins). Service client
 * after the admin check (ADR-0004).
 */
export async function setWorkerPhoto(args: {
  workerId: string;
  path: string;
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const svc = createServiceClient();
    const { error } = await svc
      .from('workers')
      .update({ photo_url: args.path })
      .eq('id', args.workerId);
    if (error) return { ok: false, error: error.message };
    // A NULL company_id collapses audit_log's INSERT policy to is_owner(), so
    // the row silently vanished for every scoped admin (#93). This action takes
    // no companyId, so name one the worker is actually linked to AND the caller
    // can see. ponytail: first such link wins.
    const links = await fetchWorkerLinks(svc, args.workerId);
    await logEvent({
      companyId:
        links.find((l) => admin.isOwner || admin.companyIds.includes(l.companyId))?.companyId ??
        null,
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { photo: true },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Failed to set photo.'),
    };
  }
}

/** Short-lived signed URL for a contractor's avatar (private bucket). */
export async function getWorkerPhotoUrl(args: {
  workerId: string;
}): Promise<ActionResult<{ url: string | null }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const svc = createServiceClient();
    const { data: w } = await svc
      .from('workers')
      .select('photo_url')
      .eq('id', args.workerId)
      .maybeSingle();
    const path = w?.photo_url;
    if (!path) return { ok: true, data: { url: null } };
    const { data: signed } = await svc.storage.from('avatars').createSignedUrl(path, 300);
    return { ok: true, data: { url: signed?.signedUrl ?? null } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Failed to load photo.'),
    };
  }
}

/** A contractor's link to one company (for the profile "Client engagements" editor). */
export interface WorkerEngagement {
  companyId: string;
  companyName: string;
  kind: string;
  contract: string;
  payBasis: string | null;
  role: string | null;
  billRateUsd: number | null;
  sessionRateUsd: number | null;
  status: string;
}

/** All company links for a worker (employer + clients), for the engagements editor. */
export async function getWorkerCompanies(args: {
  workerId: string;
}): Promise<ActionResult<{ engagements: WorkerEngagement[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const svc = createServiceClient();
    const { data, error } = await svc
      .from('worker_companies')
      .select(
        'company_id, contract, pay_basis, role, bill_rate_usd, session_rate_usd, status, companies(name, kind)',
      )
      .eq('worker_id', args.workerId);
    if (error) return { ok: false, error: error.message };
    const engagements: WorkerEngagement[] = (data ?? []).map((r) => ({
      companyId: r.company_id,
      companyName: r.companies?.name ?? '—',
      kind: r.companies?.kind ?? 'client',
      contract: r.contract,
      payBasis: r.pay_basis ?? null,
      role: r.role,
      billRateUsd: r.bill_rate_usd,
      sessionRateUsd: r.session_rate_usd,
      status: r.status,
    }));
    return { ok: true, data: { engagements } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Failed to load engagements.'),
    };
  }
}

/**
 * Update one company link's position / bill rate / contract / status (partial).
 *
 * Zod-parsed like every other action here: it was plain-typed, and TypeScript is
 * erased at runtime, so a forged POST could put `status='ended'` on a
 * service-role (RLS-bypassing) update with no `ended_on`, no rate close and no
 * coverage close — the exact #79 drift, and the time-import gate would never see
 * it (#81). Ending goes through endAssignment; see EditableWorkerStatusSchema.
 */
export async function saveWorkerCompanyLink(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SaveWorkerCompanyLinkSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  // This action writes via the service-role client (RLS bypassed), so the
  // per-company scope must be enforced here — same guard as addContractor /
  // saveWorkerProfile / hireContractor.
  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const svc = createServiceClient();
    const { error } = await svc
      .from('worker_companies')
      .update({
        role: input.role,
        bill_rate_usd: input.billRateUsd,
        session_rate_usd: input.sessionRateUsd,
        contract: input.contract,
        pay_basis: input.payBasis,
      })
      .eq('worker_id', input.workerId)
      .eq('company_id', input.companyId);
    if (error) return { ok: false, error: error.message };
    // Status in its own gated write, same as updateWorkerLink. RLS is bypassed
    // here, so nothing else stops a stale tab posting 'active' over a link
    // someone ended in another tab — reviving a departed engagement with
    // `ended_on` still set (#88, via the likelier editor). Reviving is
    // reactivateWorkerLink's job; it clears `ended_on` too. The rest of the
    // patch lands either way, so editing an ended link's role still works.
    if (input.status) {
      const { error: sErr } = await svc
        .from('worker_companies')
        .update({ status: input.status })
        .eq('worker_id', input.workerId)
        .eq('company_id', input.companyId)
        .neq('status', 'ended');
      if (sErr) return { ok: false, error: sErr.message };
    }
    await logEvent({
      companyId: input.companyId,
      action: 'edit_contractor',
      entity: input.workerId,
      detail: { engagement: input.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Save failed.'),
    };
  }
}

/** Assign a contractor to another company (new worker_companies link). */
export async function assignWorkerCompany(args: {
  workerId: string;
  companyId: string;
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  // Service-role write (RLS bypassed) — enforce per-company scope here.
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const svc = createServiceClient();
    const { data: existing } = await svc
      .from('worker_companies')
      .select('id')
      .eq('worker_id', args.workerId)
      .eq('company_id', args.companyId)
      .maybeSingle();
    if (existing) return { ok: false, error: 'Already assigned to this company.' };
    const { error } = await svc.from('worker_companies').insert({
      worker_id: args.workerId,
      company_id: args.companyId,
      contract: 'FT',
      status: 'active',
    });
    if (error) return { ok: false, error: error.message };
    await logEvent({
      companyId: args.companyId,
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { assigned: args.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Assign failed.'),
    };
  }
}

/**
 * Remove a contractor's CLIENT assignment (delete the worker_companies link).
 * Hard delete so the client can be re-assigned later (assignWorkerCompany blocks
 * re-adding while any link exists). The employer link can never be removed.
 */
export async function unassignWorkerCompany(args: {
  workerId: string;
  companyId: string;
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  try {
    const svc = createServiceClient();
    const { data: company } = await svc
      .from('companies')
      .select('kind')
      .eq('id', args.companyId)
      .maybeSingle();
    if (company?.kind === 'employer') {
      return { ok: false, error: "Can't remove the employer assignment." };
    }
    const { error } = await svc
      .from('worker_companies')
      .delete()
      .eq('worker_id', args.workerId)
      .eq('company_id', args.companyId);
    if (error) return { ok: false, error: error.message };
    await logEvent({
      companyId: args.companyId,
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { unassigned: args.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Remove failed.'),
    };
  }
}

// ─── "Onboard Current Contractor" (invite an existing worker to the portal) ─────

export interface OnboardCandidate {
  workerId: string;
  name: string;
  email: string | null;
}

/**
 * Active workers on this company with no portal login yet — the population the
 * "Onboard Current Contractor" wizard serves. Service client: contractor_logins
 * has SELECT-only self RLS, so the admin session can't read it directly.
 */
export async function listOnboardCandidates(
  companyId: string,
): Promise<ActionResult<OnboardCandidate[]>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const svc = createServiceClient();
    const [linksRes, loginsRes] = await Promise.all([
      svc
        .from('worker_companies')
        .select('worker_id, workers!inner(id, first_name, last_name, email, status)')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .eq('workers.status', 'active'),
      svc.from('contractor_logins').select('worker_id'),
    ]);
    if (linksRes.error) return { ok: false, error: linksRes.error.message };
    const hasLogin = new Set((loginsRes.data ?? []).map((l) => l.worker_id));
    const out: OnboardCandidate[] = (linksRes.data ?? [])
      .filter((l) => !hasLogin.has(l.worker_id))
      .map((l) => ({
        workerId: l.worker_id,
        name: `${l.workers.first_name} ${l.workers.last_name}`.trim(),
        email: l.workers.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, data: out };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Failed to load contractors.') };
  }
}

/** Derived agreement terms for a candidate — prefills the wizard's form. */
export async function getOnboardPrefill(
  workerId: string,
): Promise<ActionResult<DerivedAgreementPrefill>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  try {
    const svc = createServiceClient();
    return { ok: true, data: await deriveAgreementPrefill(svc, workerId) };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Failed to derive terms.') };
  }
}

/**
 * Onboard an EXISTING worker: create their portal login (welcome email, seeds
 * the onboarding queue) and prepare the agreement prefill with the terms the
 * admin confirmed in the wizard. Mirrors hireContractor's per-hire prep block,
 * but touches no worker / link / rate rows. createPortalLogin is the gate —
 * its duplicate-login/email guards apply; the prep after it is best-effort
 * (fixable from the onboarding review panel), same stance as the hire wizard.
 */
export async function onboardCurrentContractor(
  args: unknown,
): Promise<ActionResult<{ tempPassword?: string; emailSent?: boolean; email?: string }>> {
  const parsed = OnboardCurrentSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const loginRes = await createPortalLogin({ workerId: input.workerId, email: input.email });
  if (!loginRes.ok) return loginRes;

  try {
    const svc = createServiceClient();
    const now = new Date().toISOString();
    const { data: co } = await svc
      .from('companies')
      .select('name')
      .eq('id', input.companyId)
      .maybeSingle();

    // Overwrites the derived defaults createPortalLogin just seeded with the
    // values the admin confirmed. Same field layout as the hire wizard: terms
    // on the IC Agreement, engagement basis + countersigner on all four.
    for (const kind of AGREEMENT_KINDS) {
      await svc.from('onboarding_agreements').upsert(
        {
          worker_id: input.workerId,
          agreement_kind: kind,
          f_company_name: co?.name ?? null,
          f_employment_type: input.employmentType,
          f_hours_per_week: input.hoursPerWeek,
          countersigner_user_id: input.countersignerUserId,
          countersigner_name: input.countersignerName,
          prepared_by: admin.userId,
          prepared_at: now,
          updated_at: now,
          ...(kind === 'ic_agreement'
            ? {
                f_rate: input.ratePhp > 0 ? String(input.ratePhp) : null,
                f_position: input.position,
                f_start_date: input.startDate,
                addendum_type: input.icAddendumType || null,
                addendum_text: input.icAddendumText?.trim() || null,
              }
            : {}),
        },
        { onConflict: 'worker_id,agreement_kind' },
      );
    }

    const tr = input.tools;
    if (tr.gmail || tr.providersoft || tr.hubstaff || tr.zoom || tr.others.trim()) {
      await svc.rpc('set_tools_requested', {
        p_worker_id: input.workerId,
        p_requested: tr as unknown as Json,
      });
    }
  } catch {
    /* non-fatal: the login/invite already succeeded */
  }

  await logEvent({
    companyId: input.companyId,
    action: 'onboard_current_contractor',
    entity: input.workerId,
    detail: { email: input.email, by: admin.email },
  });
  revalidatePath('/onboarding');
  return loginRes;
}
