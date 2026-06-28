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
  insertWorkerWithLink,
  setWorkerLinkStatus,
  updateWorkerLink,
  updateWorkerProfile,
} from '@/db/queries/workers';
import type { Json } from '@/db/types';
import { saveRate } from '@/server/actions/payroll';
import { type ActionResult, createPortalLogin } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  AddContractorSchema,
  type ContractType,
  HireContractorSchema,
  type PayBasis,
  SaveWorkerProfileSchema,
  SetLinkStatusSchema,
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
      error: err instanceof Error ? err.message : 'Create failed.',
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
      status: input.linkStatus,
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
      error: err instanceof Error ? err.message : 'Save failed.',
    };
  }
}

/** Deactivate or reactivate a contractor's company link. */
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

  try {
    const db = await createServerSupabase();
    await setWorkerLinkStatus(db, input.workerId, input.companyId, input.active);
    await logEvent({
      companyId: input.companyId,
      action: 'edit_contractor',
      entity: input.workerId,
      detail: { status: input.active ? 'active' : 'ended' },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Status update failed.',
    };
  }
}

/** Onboarding agreement kinds prefilled at hire time (IC first, then the rest). */
const ONB_AGR_KINDS = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'] as const;

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
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to load clients.' };
  }
}

export async function hireContractor(
  args: unknown,
): Promise<ActionResult<{ workerId: string; tempPassword?: string }>> {
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
    if (input.invite && input.email) {
      const loginRes = await createPortalLogin({
        workerId,
        email: input.email,
      });
      if (!loginRes.ok) throw new Error(loginRes.error);
      tempPassword = loginRes.data.tempPassword;
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
        for (const k of ONB_AGR_KINDS) {
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
      ? { ok: true, data: { workerId, tempPassword } }
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
      error: err instanceof Error ? err.message : 'Hire failed.',
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
    await logEvent({
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { photo: true },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to set photo.',
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
      error: err instanceof Error ? err.message : 'Failed to load photo.',
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
      error: err instanceof Error ? err.message : 'Failed to load engagements.',
    };
  }
}

/** Update one company link's position / bill rate / contract / status (partial). */
export async function saveWorkerCompanyLink(args: {
  workerId: string;
  companyId: string;
  role: string | null;
  billRateUsd: number | null;
  sessionRateUsd: number | null;
  contract: ContractType;
  payBasis: PayBasis | null;
  status: 'active' | 'inactive' | 'ended';
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  // This action writes via the service-role client (RLS bypassed), so the
  // per-company scope must be enforced here — same guard as addContractor /
  // saveWorkerProfile / hireContractor.
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }
  // A PHS engagement with no pay_basis is unpayable (payModelFor → 'unset' →
  // the worker is silently dropped from payroll). The Add/Hire/Profile paths
  // enforce this via the requirePayBasisForPhs zod refinement; this plain-typed
  // action needs the equivalent runtime guard.
  if (args.contract === 'PHS' && args.payBasis == null) {
    return {
      ok: false,
      error: 'Choose a pay basis (per hour or per session) for a per-hour/session contract.',
    };
  }
  try {
    const svc = createServiceClient();
    const { error } = await svc
      .from('worker_companies')
      .update({
        role: args.role,
        bill_rate_usd: args.billRateUsd,
        session_rate_usd: args.sessionRateUsd,
        contract: args.contract,
        pay_basis: args.payBasis,
        status: args.status,
      })
      .eq('worker_id', args.workerId)
      .eq('company_id', args.companyId);
    if (error) return { ok: false, error: error.message };
    await logEvent({
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { engagement: args.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Save failed.',
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
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { assigned: args.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Assign failed.',
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
      action: 'edit_contractor',
      entity: args.workerId,
      detail: { unassigned: args.companyId },
    });
    revalidatePath('/contractors');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Remove failed.',
    };
  }
}
