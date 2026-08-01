/**
 * Worker query module — ALL worker/roster DB reads and writes for the
 * contractors admin screen live here. Client passed as first arg (ADR-0002/0003).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import type { Database } from '@/db/types';
import { uuid } from '@/types/schemas/uuid';

type Db = SupabaseClient<Database>;

/** Read a string key out of the profile_extras jsonb, else null. */
const extraStr = (j: unknown, k: string): string | null => {
  if (j && typeof j === 'object') {
    const v = (j as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : null;
  }
  return null;
};

export type RosterWorker = {
  workerId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string | null;
  mobile: string | null;
  phAddress: string | null;
  permanentAddress: string | null;
  addressLandmark: string | null;
  postalCode: string | null;
  hireDate: string | null;
  workerStatus: Database['public']['Enums']['worker_status'];
  payoutMethod: Database['public']['Enums']['payout_method'] | null;
  healthAllowanceEligible: boolean;
  thirteenthMonthEligible: boolean;
  // Personal / HR (workers table)
  workEmail: string | null;
  workNumber: string | null;
  workExtension: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
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
  /** Wise API recipient id (numeric) — the payee for Wise API draft transfers. */
  wiseRecipientId: number | null;
  /** Wise recipient UUID — used by the manual Wise Batch Payments CSV. */
  wiseRecipientUuid: string | null;
  // About / culture (profile_extras jsonb; also self-maintained via the portal).
  favoriteColor: string | null;
  favoriteFood: string | null;
  motto: string | null;
  photoUrl: string | null;
  // worker_companies link fields
  linkId: string;
  companyId: string;
  contract: Database['public']['Enums']['contract_type'];
  /** PHS unit: 'hourly' | 'per_session' (else null). */
  payBasis: string | null;
  role: string | null;
  hubstaffName: string | null;
  weeklyHours: number | null;
  billRateUsd: number | null;
  sessionRateUsd: number | null;
  linkStatus: Database['public']['Enums']['worker_status'];
};

/**
 * Roster for a single company: worker_companies joined to workers, newest
 * created first. Current rate is resolved by the caller from the rates query.
 *
 * `cache()`-wrapped: the admin layout fetches the roster for the ⌘K palette on
 * every page, and pages like /contractors fetch it again. With one cached
 * Supabase client (same `db` reference), this collapses to a single query per
 * request. Keyed on (db, companyId), so a different client/company never reuses.
 */
export const fetchRoster = cache(async (db: Db, companyId: string): Promise<RosterWorker[]> => {
  const SEL =
    'id, worker_id, company_id, contract, pay_basis, role, hubstaff_name, weekly_hours, bill_rate_usd, session_rate_usd, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible, work_email, work_number, work_extension, shift_start, shift_end, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, wise_recipient_id, wise_recipient_uuid, profile_extras, photo_url)' as const;

  const { data, error } = await db
    .from('worker_companies')
    .select(SEL)
    .eq('company_id', companyId)
    .order('id', { ascending: false });
  if (error) throw new Error(`worker_companies: ${error.message}`);

  return (data ?? [])
    .filter(
      (l): l is typeof l & { workers: NonNullable<(typeof l)['workers']> } => l.workers != null,
    )
    .map((l) => {
      const w = l.workers;
      return {
        workerId: l.worker_id,
        firstName: w.first_name,
        middleName: w.middle_name,
        lastName: w.last_name,
        email: w.email,
        mobile: w.mobile,
        phAddress: w.ph_address,
        permanentAddress: w.permanent_address,
        addressLandmark: w.address_landmark,
        postalCode: w.postal_code,
        hireDate: w.hire_date,
        workerStatus: w.status,
        payoutMethod: w.payout_method,
        healthAllowanceEligible: w.health_allowance_eligible,
        thirteenthMonthEligible: w.thirteenth_month_eligible,
        workEmail: w.work_email,
        workNumber: w.work_number,
        workExtension: w.work_extension,
        shiftStart: w.shift_start,
        shiftEnd: w.shift_end,
        dateOfBirth: w.date_of_birth,
        emergencyName: w.emergency_name,
        emergencyRelationship: w.emergency_relationship,
        emergencyMobile: w.emergency_mobile,
        maritalStatus: w.marital_status,
        educationLevel: w.education_level,
        course: w.course,
        yearGraduated: w.year_graduated,
        school: w.school,
        gcash: w.gcash,
        paymaya: w.paymaya,
        paypal: w.paypal,
        wiseTag: w.wise_tag,
        wiseRecipientId: w.wise_recipient_id,
        wiseRecipientUuid: w.wise_recipient_uuid,
        favoriteColor: extraStr(w.profile_extras, 'favorite_color'),
        favoriteFood: extraStr(w.profile_extras, 'favorite_food'),
        motto: extraStr(w.profile_extras, 'motto'),
        photoUrl: w.photo_url,
        linkId: l.id,
        companyId: l.company_id,
        contract: l.contract,
        payBasis: l.pay_basis ?? null,
        role: l.role,
        hubstaffName: l.hubstaff_name,
        weeklyHours: l.weekly_hours,
        billRateUsd: l.bill_rate_usd,
        sessionRateUsd: l.session_rate_usd,
        linkStatus: l.status,
      };
    });
});

export type RosterIndexRow = {
  workerId: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
};

/**
 * Lightweight roster projection — just worker id + name parts, NOT the ~45-column
 * HR record {@link fetchRoster} pulls. Powers the ⌘K command palette (admin
 * layout, every route) and the /documents contractor dropdown, which need only
 * `{id, name}`. `cache()`-wrapped on (db, companyId) so the layout + page share
 * one query per request.
 */
export const fetchRosterIndex = cache(
  async (db: Db, companyId: string): Promise<RosterIndexRow[]> => {
    const { data, error } = await db
      .from('worker_companies')
      .select('worker_id, workers(first_name, middle_name, last_name)')
      .eq('company_id', companyId)
      .order('id', { ascending: false });
    if (error) throw new Error(`worker_companies index: ${error.message}`);
    return (data ?? [])
      .filter(
        (l): l is typeof l & { workers: NonNullable<(typeof l)['workers']> } => l.workers != null,
      )
      .map((l) => ({
        workerId: l.worker_id,
        firstName: l.workers.first_name,
        middleName: l.workers.middle_name,
        lastName: l.workers.last_name,
      }));
  },
);

/** Fetch a single worker_companies row joined to worker, or null. */
export const fetchWorkerLink = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<RosterWorker | null> => {
  // A non-UUID route param would otherwise throw a raw Postgres cast error;
  // treat it as "no such worker" so callers' existing notFound() runs.
  if (!uuid().safeParse(workerId).success) return null;
  const SEL2 =
    'id, worker_id, company_id, contract, pay_basis, role, hubstaff_name, weekly_hours, bill_rate_usd, session_rate_usd, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible, work_email, work_number, work_extension, shift_start, shift_end, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, wise_recipient_id, wise_recipient_uuid, profile_extras, photo_url)' as const;

  const { data, error } = await db
    .from('worker_companies')
    .select(SEL2)
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw new Error(`worker_companies: ${error.message}`);
  if (!data?.workers) return null;
  const w = data.workers;
  return {
    workerId: data.worker_id,
    firstName: w.first_name,
    middleName: w.middle_name,
    lastName: w.last_name,
    email: w.email,
    mobile: w.mobile,
    phAddress: w.ph_address,
    permanentAddress: w.permanent_address,
    addressLandmark: w.address_landmark,
    postalCode: w.postal_code,
    hireDate: w.hire_date,
    workerStatus: w.status,
    payoutMethod: w.payout_method,
    healthAllowanceEligible: w.health_allowance_eligible,
    thirteenthMonthEligible: w.thirteenth_month_eligible,
    workEmail: w.work_email,
    workNumber: w.work_number,
    workExtension: w.work_extension,
    shiftStart: w.shift_start,
    shiftEnd: w.shift_end,
    dateOfBirth: w.date_of_birth,
    emergencyName: w.emergency_name,
    emergencyRelationship: w.emergency_relationship,
    emergencyMobile: w.emergency_mobile,
    maritalStatus: w.marital_status,
    educationLevel: w.education_level,
    course: w.course,
    yearGraduated: w.year_graduated,
    school: w.school,
    gcash: w.gcash,
    paymaya: w.paymaya,
    paypal: w.paypal,
    wiseTag: w.wise_tag,
    wiseRecipientId: w.wise_recipient_id,
    wiseRecipientUuid: w.wise_recipient_uuid,
    favoriteColor: extraStr(w.profile_extras, 'favorite_color'),
    favoriteFood: extraStr(w.profile_extras, 'favorite_food'),
    motto: extraStr(w.profile_extras, 'motto'),
    photoUrl: w.photo_url,
    linkId: data.id,
    companyId: data.company_id,
    contract: data.contract,
    payBasis: data.pay_basis ?? null,
    role: data.role,
    hubstaffName: data.hubstaff_name,
    weeklyHours: data.weekly_hours,
    billRateUsd: data.bill_rate_usd,
    sessionRateUsd: data.session_rate_usd,
    linkStatus: data.status,
  };
};

/**
 * Map each worker → the names of the active CLIENT companies they're assigned to
 * (worker_companies links to companies with kind='client'). Powers the
 * contractors-table CLIENT(S) column.
 */
export const fetchWorkerClientsMap = async (
  db: Db,
  workerIds: string[],
): Promise<Record<string, string[]>> => {
  if (workerIds.length === 0) return {};
  const { data, error } = await db
    .from('worker_companies')
    .select('worker_id, status, companies(name, kind)')
    .in('worker_id', workerIds);
  if (error) throw new Error(`worker clients: ${error.message}`);
  const map: Record<string, string[]> = {};
  for (const r of data ?? []) {
    const c = r.companies;
    if (c?.kind !== 'client' || r.status === 'ended') continue;
    const arr = map[r.worker_id] ?? [];
    arr.push(c.name);
    map[r.worker_id] = arr;
  }
  return map;
};

/** Insert a new worker and link row. Returns the new worker_id. */
export const insertWorkerWithLink = async (
  db: Db,
  args: {
    firstName: string;
    lastName: string;
    companyId: string;
    contract: Database['public']['Enums']['contract_type'];
    payBasis?: string | null;
  },
): Promise<string> => {
  const { data: worker, error: workerErr } = await db
    .from('workers')
    .insert({
      first_name: args.firstName,
      last_name: args.lastName,
      status: 'active',
      health_allowance_eligible: true,
      thirteenth_month_eligible: true,
    })
    .select('id')
    .single();
  if (workerErr) throw new Error(`workers insert: ${workerErr.message}`);

  const { error: linkErr } = await db.from('worker_companies').insert({
    worker_id: worker.id,
    company_id: args.companyId,
    contract: args.contract,
    pay_basis: args.payBasis ?? null,
    status: 'active',
  });
  if (linkErr) {
    // orphan cleanup best-effort
    await db.from('workers').delete().eq('id', worker.id);
    throw new Error(`worker_companies insert: ${linkErr.message}`);
  }

  return worker.id;
};

/** Update worker profile fields (workers table). */
export const updateWorkerProfile = async (
  db: Db,
  workerId: string,
  patch: {
    first_name: string;
    middle_name: string | null;
    last_name: string;
    email: string | null;
    mobile: string | null;
    hire_date: string | null;
    ph_address: string | null;
    permanent_address: string | null;
    address_landmark: string | null;
    postal_code: string | null;
    payout_method: Database['public']['Enums']['payout_method'] | null;
    health_allowance_eligible: boolean;
    thirteenth_month_eligible: boolean;
    work_email?: string | null;
    work_number?: string | null;
    work_extension?: string | null;
    shift_start?: string | null;
    shift_end?: string | null;
    date_of_birth?: string | null;
    emergency_name?: string | null;
    emergency_relationship?: string | null;
    emergency_mobile?: string | null;
    marital_status?: string | null;
    education_level?: string | null;
    course?: string | null;
    year_graduated?: string | null;
    school?: string | null;
    gcash?: string | null;
    paymaya?: string | null;
    paypal?: string | null;
    wise_tag?: string | null;
    wise_recipient_id?: number | null;
    wise_recipient_uuid?: string | null;
    profile_extras?: Database['public']['Tables']['workers']['Row']['profile_extras'];
  },
): Promise<void> => {
  const { error } = await db.from('workers').update(patch).eq('id', workerId);
  if (error) throw new Error(`workers update: ${error.message}`);
};

/** Update worker_companies link fields. */
export const updateWorkerLink = async (
  db: Db,
  workerId: string,
  companyId: string,
  patch: {
    contract: Database['public']['Enums']['contract_type'];
    pay_basis?: string | null;
    role: string | null;
    hubstaff_name: string | null;
    weekly_hours: number | null;
    bill_rate_usd?: number | null;
    session_rate_usd?: number | null;
    status: Database['public']['Enums']['worker_status'];
  },
): Promise<void> => {
  const { error } = await db
    .from('worker_companies')
    .update(patch)
    .eq('worker_id', workerId)
    .eq('company_id', companyId);
  if (error) throw new Error(`worker_companies update: ${error.message}`);
};

/** Set a worker's link status (active/inactive/ended) and mirror to worker.status. */
export const setWorkerLinkStatus = async (
  db: Db,
  workerId: string,
  companyId: string,
  active: boolean,
): Promise<void> => {
  const workerStatus: Database['public']['Enums']['worker_status'] = active ? 'active' : 'ended';
  const linkStatus: Database['public']['Enums']['worker_status'] = active ? 'active' : 'ended';

  const { error: wErr } = await db
    .from('workers')
    .update({ status: workerStatus })
    .eq('id', workerId);
  if (wErr) throw new Error(`workers status update: ${wErr.message}`);

  const { error: lErr } = await db
    .from('worker_companies')
    .update({
      status: linkStatus,
      ended_on: active ? null : new Date().toISOString().slice(0, 10),
    })
    .eq('worker_id', workerId)
    .eq('company_id', companyId);
  if (lErr) throw new Error(`worker_companies status update: ${lErr.message}`);
};

export type EndEngagementResult = {
  /** Company ids whose link this call ended. */
  endedCompanyIds: string[];
  /** Links still 'active' for this worker AFTER the end. */
  remainingActive: number;
};

/**
 * End an engagement as of `lastDay` — ONE company link, or every link when
 * `companyId` is null (full termination).
 *
 * Closes the three open-ended things a departure leaves dangling, which is the
 * whole point of routing both flows through here rather than a bare status
 * write:
 *   1. the link  — status 'ended' + `ended_on` (the date nothing read before)
 *   2. rates     — `effective_end`, so a later recalc can't resolve pay past
 *                  the last day (the root cause behind the #75 allowance bug)
 *   3. coverage targets — `effective_to`, so /overview stops expecting hours
 *
 * Caller decides what `workers.status` becomes: 'ended' for a termination,
 * 'inactive' when this was their last active assignment.
 */
export const endEngagement = async (
  db: Db,
  args: { workerId: string; companyId: string | null; lastDay: string },
): Promise<EndEngagementResult> => {
  const forOneCompany = <T extends { eq: (col: string, val: string) => T }>(q: T): T =>
    args.companyId === null ? q : q.eq('company_id', args.companyId);

  const { data: ended, error: linkErr } = await forOneCompany(
    db
      .from('worker_companies')
      .update({ status: 'ended' as const, ended_on: args.lastDay })
      .eq('worker_id', args.workerId),
  ).select('company_id');
  if (linkErr) throw new Error(`worker_companies end: ${linkErr.message}`);

  const { error: rateErr } = await forOneCompany(
    db
      .from('rates')
      .update({ effective_end: args.lastDay })
      .eq('worker_id', args.workerId)
      .is('effective_end', null)
      // rates_check is `effective_end >= effective_start`, so never close a rate
      // that starts AFTER the last day — a future-dated raise for someone who
      // left is left alone (harmless: their link is ended, so no row is built).
      .lte('effective_start', args.lastDay),
  );
  if (rateErr) throw new Error(`rates close: ${rateErr.message}`);

  const { error: targetErr } = await forOneCompany(
    db
      .from('coverage_targets')
      .update({ effective_to: args.lastDay })
      .eq('worker_id', args.workerId)
      .is('effective_to', null)
      // Same CHECK shape as rates (effective_to >= effective_from).
      .lte('effective_from', args.lastDay),
  );
  if (targetErr) throw new Error(`coverage_targets close: ${targetErr.message}`);

  const { count, error: countErr } = await db
    .from('worker_companies')
    .select('company_id', { count: 'exact', head: true })
    .eq('worker_id', args.workerId)
    .eq('status', 'active');
  if (countErr) throw new Error(`worker_companies remaining: ${countErr.message}`);

  return {
    endedCompanyIds: (ended ?? []).map((r) => r.company_id),
    remainingActive: count ?? 0,
  };
};

/** Set `workers.status` directly (termination / last-assignment-ended). */
export const setWorkerStatus = async (
  db: Db,
  workerId: string,
  status: Database['public']['Enums']['worker_status'],
): Promise<void> => {
  const { error } = await db.from('workers').update({ status }).eq('id', workerId);
  if (error) throw new Error(`workers status update: ${error.message}`);
};

/** Company ids this worker is linked to, any status — for admin scope checks. */
export const fetchWorkerCompanyIds = async (db: Db, workerId: string): Promise<string[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('company_id')
    .eq('worker_id', workerId);
  if (error) throw new Error(`worker_companies ids: ${error.message}`);
  return (data ?? []).map((r) => r.company_id);
};

/**
 * Is money still owed to a departed contractor?
 *
 * This is the whole basis for portal access after a termination. `terminateContractor`
 * deliberately leaves the login alone, so access is derived here at sign-in instead of
 * revoked on the last day: someone who has left keeps their payslips, statements and
 * documents until the money is actually in their hands.
 *
 * Three ways pay is still owed. Access ends only when ALL of them are false:
 *   1. a payment row that hasn't landed (`paid_at IS NULL` — draft/queued/failed)
 *   2. no landed payment covering the last day yet. The final period may simply not
 *      have been run, so the row that will owe them does not exist to check. This is
 *      what makes the rule safe the day after a termination: end someone on the 15th,
 *      payroll runs on the 30th, and the gap between is exactly when they most need
 *      the portal — a payments-only check would lock them out for all of it.
 *   3. approved sessions not yet paid — off-cycle work no period covers.
 *
 * Every unknown resolves to "still owed". Locking someone out early is the expensive
 * mistake; leaving a read-only view of their own rows open longer than strictly needed
 * is not.
 *
 * Takes the SERVICE client: `worker_companies` is admin-only under RLS, so a contractor
 * reading it resolves zero rows and would silently look fully paid. Scoped by
 * `worker_id` in every query, the same way fetchUnpaidApprovedSessions is.
 */
export const hasPayOutstanding = async (db: Db, workerId: string): Promise<boolean> => {
  const { data: links, error: lErr } = await db
    .from('worker_companies')
    .select('ended_on')
    .eq('worker_id', workerId);
  if (lErr) throw new Error(`worker_companies ended_on: ${lErr.message}`);

  // Latest last day across every engagement — the date final pay has to cover.
  // Null when no link was ever stamped (an 'ended' worker from the #79 drift,
  // written before endEngagement existed): nothing to prove final pay against,
  // so keep access rather than guess.
  const lastDay = (links ?? [])
    .map((l) => l.ended_on)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  if (!lastDay) return true;

  const { data: pays, error: pErr } = await db
    .from('payments')
    .select('paid_at, pay_periods(period_end)')
    .eq('worker_id', workerId);
  if (pErr) throw new Error(`payments outstanding: ${pErr.message}`);
  const rows = pays ?? [];

  if (rows.some((p) => p.paid_at === null)) return true;
  // Everything left has landed, so covering the last day is enough to call it
  // final. Both are date columns ('YYYY-MM-DD'), which compare correctly as text.
  if (!rows.some((p) => (p.pay_periods?.period_end ?? '') >= lastDay)) return true;

  const { count, error: sErr } = await db
    .from('service_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', workerId)
    .eq('approval', 'approved')
    .is('paid_at', null);
  if (sErr) throw new Error(`unpaid sessions: ${sErr.message}`);
  return (count ?? 0) > 0;
};

/** Wipe stored tool credentials — a terminated contractor can't be handed them. */
export const clearWorkerTools = async (db: Db, workerId: string): Promise<void> => {
  const { error } = await db
    .from('worker_tools')
    .update({ enc: null, popup_pending: false })
    .eq('worker_id', workerId);
  if (error) throw new Error(`worker_tools clear: ${error.message}`);
};
