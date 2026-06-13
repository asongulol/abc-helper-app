'use server';

/**
 * Contractor server actions — add_contractor, edit_contractor.
 * Pattern: verify admin → company scope check → Zod validate → query module →
 * audit log. No inline SQL, no money math.
 */

import { createServerSupabase } from '@/db/clients/server';
import {
  insertWorkerWithLink,
  setWorkerLinkStatus,
  updateWorkerLink,
  updateWorkerProfile,
} from '@/db/queries/workers';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  AddContractorSchema,
  SaveWorkerProfileSchema,
  SetLinkStatusSchema,
} from '@/types/schemas/contractors';

/** Quick-add a blank contractor and link them to the selected company. */
export async function addContractor(args: unknown): Promise<ActionResult<{ workerId: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = AddContractorSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
    });
    await logEvent({
      companyId: input.companyId,
      action: 'add_contractor',
      entity: `${input.firstName} ${input.lastName}`.trim(),
      detail: { from: 'contractors tab' },
    });
    return { ok: true, data: { workerId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Create failed.' };
  }
}

/** Save profile + link fields for an existing contractor. */
export async function saveWorkerProfile(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SaveWorkerProfileSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
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
    });
    await updateWorkerLink(db, input.workerId, input.companyId, {
      contract: input.contract,
      role: input.role,
      hubstaff_name: input.hubstaffName,
      weekly_hours: input.weeklyHours,
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
    return { ok: false, error: err instanceof Error ? err.message : 'Save failed.' };
  }
}

/** Deactivate or reactivate a contractor's company link. */
export async function setContractorLinkStatus(args: unknown): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = SetLinkStatusSchema.safeParse(args);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
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
    return { ok: false, error: err instanceof Error ? err.message : 'Status update failed.' };
  }
}
