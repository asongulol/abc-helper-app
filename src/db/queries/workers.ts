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
    /** Omitted leaves the current status alone. 'ended' is not writable here —
     *  that is endEngagement's job, which also closes rates and coverage. */
    status?: 'active' | 'inactive';
  },
): Promise<void> => {
  const { status, ...rest } = patch;
  const { error } = await db
    .from('worker_companies')
    .update(rest)
    .eq('worker_id', workerId)
    .eq('company_id', companyId);
  if (error) throw new Error(`worker_companies update: ${error.message}`);
  if (!status) return;

  // Status goes in its own gated write. A profile form opened while the
  // contractor was active still submits 'active' after someone else ended the
  // link in another tab, which put a departed worker back on the roster with
  // `ended_on` still set — active and unpayable (#88). Reviving an ended link is
  // reactivateWorkerLink's job; it clears `ended_on` too. The rest of the patch
  // lands either way, so editing a departed contractor's role still works.
  const { error: sErr } = await db
    .from('worker_companies')
    .update({ status })
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .neq('status', 'ended');
  if (sErr) throw new Error(`worker_companies status update: ${sErr.message}`);
};

/**
 * Bring a worker's company link back to 'active' and mirror it to worker.status.
 *
 * Reactivation only, on purpose. This used to take an `active` boolean and
 * stamp `ended_on` with TODAY on the way down — a second writer of the ended
 * state that closed neither rates nor coverage targets, which is what left 6
 * ended workers on active links (#79). Ending now has exactly one home,
 * `endEngagement`, which closes all three as of the chosen last day.
 *
 * So this reopens all three too. Reviving only the link left the rate and the
 * coverage target closed, and the next payroll skipped the reinstated
 * contractor for "no rate" (#95) until an admin re-typed both by hand.
 */
export const reactivateWorkerLink = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<void> => {
  // Read the last day before clearing it — it is what identifies the rows the
  // termination closed.
  const { data: link, error: rErr } = await db
    .from('worker_companies')
    .select('ended_on')
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (rErr) throw new Error(`worker_companies ended_on: ${rErr.message}`);

  const { error: wErr } = await db
    .from('workers')
    .update({ status: 'active' as const })
    .eq('id', workerId);
  if (wErr) throw new Error(`workers status update: ${wErr.message}`);

  const { error: lErr } = await db
    .from('worker_companies')
    .update({ status: 'active' as const, ended_on: null })
    .eq('worker_id', workerId)
    .eq('company_id', companyId);
  if (lErr) throw new Error(`worker_companies status update: ${lErr.message}`);

  const lastDay = link?.ended_on;
  if (!lastDay) return;

  // Status first, rates last: if a reopen fails the link is back but the rate is
  // still closed — visible as PayrollShell's "skipped (no rate)", which is the
  // behaviour that existed before this. The other order would leave an open rate
  // on an ended link, which is the #75 recalc hazard.
  //
  // ponytail: matched by date, so a rate a RAISE closed on that same date
  // reopens too — the one-open-rate-per-(worker,company) partial unique index
  // then rejects the write loudly. Upgrade path if that ever fires: have
  // endEngagement record which rows it closed.
  const { error: rateErr } = await db
    .from('rates')
    .update({ effective_end: null })
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .eq('effective_end', lastDay);
  if (rateErr) throw new Error(`rates reopen: ${rateErr.message}`);

  const { error: targetErr } = await db
    .from('coverage_targets')
    .update({ effective_to: null })
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .eq('effective_to', lastDay);
  if (targetErr) throw new Error(`coverage_targets reopen: ${targetErr.message}`);
};

export type EndEngagementResult = {
  /** Company ids whose link this call ended. Empty means nothing was still open. */
  endedCompanyIds: string[];
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
 * Already-ended links are left completely alone — see the filter below.
 *
 * Caller decides what `workers.status` becomes: 'ended' for a termination,
 * 'inactive' when this was their last active assignment. That decision needs a
 * GLOBAL view of the worker's links, which this client cannot give (#83), so it
 * is made from {@link fetchWorkerLinks} on the service client instead.
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
      .eq('worker_id', args.workerId)
      // Never touch a link that already ended. Re-stamping `ended_on` erases the
      // real last day AND re-opens the time-import guard (time.ts:398) for every
      // date in between, making months of past hours importable and payable
      // (#89). It is also what let a second "End…" click end a departed worker
      // all over again (#88).
      .neq('status', 'ended'),
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

  return { endedCompanyIds: (ended ?? []).map((r) => r.company_id) };
};

/**
 * Set `workers.status` directly (termination / last-assignment-ended).
 *
 * Never lifts 'ended': a departed contractor is only brought back by
 * reactivateWorkerLink, which clears `ended_on` with it. Without this a stale
 * "End assignment" click on someone already terminated dropped them to
 * 'inactive' — back on the roster, and past the portal's final-pay gate for
 * good (#88).
 */
export const setWorkerStatus = async (
  db: Db,
  workerId: string,
  status: Database['public']['Enums']['worker_status'],
): Promise<void> => {
  const { error } = await db
    .from('workers')
    .update({ status })
    .eq('id', workerId)
    .neq('status', 'ended');
  if (error) throw new Error(`workers status update: ${error.message}`);
};

export type WorkerLink = {
  companyId: string;
  status: Database['public']['Enums']['worker_status'];
};

/**
 * Every company link this worker has, any status.
 *
 * Pass the SERVICE client. `worker_companies_admin_all` scopes rows to the
 * caller's own companies, so read through an admin's client this list is always
 * a subset of `admin.companyIds` — which made the cross-company terminate guard
 * vacuously true (#82) and let ending one company's assignment flip a worker
 * still working elsewhere to 'inactive' globally (#83). Both write
 * `workers.status`, which is global; the input has to be global too.
 *
 * Scoped by `worker_id` only, like hasPayOutstanding — it exposes nothing the
 * caller isn't already acting on.
 */
export const fetchWorkerLinks = async (db: Db, workerId: string): Promise<WorkerLink[]> => {
  const { data, error } = await db
    .from('worker_companies')
    .select('company_id, status')
    .eq('worker_id', workerId);
  if (error) throw new Error(`worker_companies links: ${error.message}`);
  return (data ?? []).map((r) => ({ companyId: r.company_id, status: r.status }));
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
 *   2. an ended engagement whose last day no landed payment covers yet. The final
 *      period may simply not have been run, so the row that will owe them does not
 *      exist to check. This is what makes the rule safe the day after a termination:
 *      end someone on the 15th, payroll runs on the 30th, and the gap between is
 *      exactly when they most need the portal — a payments-only check would lock
 *      them out for all of it.
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
    .select('company_id, ended_on')
    .eq('worker_id', workerId);
  if (lErr) throw new Error(`worker_companies ended_on: ${lErr.message}`);

  // One obligation per ended engagement: debts are per-company (`payments` and
  // `pay_periods` both carry `company_id`), so each company owes pay through ITS
  // OWN last day, not through the latest one anywhere (#90).
  //
  // Empty when no link was ever stamped (an 'ended' worker from the #79 drift,
  // written before endEngagement existed): nothing to prove final pay against,
  // so keep access rather than guess.
  const owed = (links ?? []).filter(
    (l): l is { company_id: string; ended_on: string } => l.ended_on !== null,
  );
  if (owed.length === 0) return true;

  const { data: pays, error: pErr } = await db
    .from('payments')
    .select('paid_at, company_id, pay_periods(period_start, period_end)')
    .eq('worker_id', workerId);
  if (pErr) throw new Error(`payments outstanding: ${pErr.message}`);
  const rows = pays ?? [];

  // ponytail: `paid_at` means SENT, not landed — wisePoll deliberately leaves the
  // DB untouched for cancelled / funds_refunded / bounced_back (wise/service.ts),
  // so a bounced final transfer still reads as paid here (#90 B). There is no DB
  // signal to check; the fix belongs where the signal goes missing (have the poll
  // record the failure), not in a guess here. Self-heals when an admin re-drafts.
  if (rows.some((p) => p.paid_at === null)) return true;

  // Everything left has landed, but a landed payment settles exactly ONE company's
  // last day, and only if its period actually CONTAINS that day. Before this,
  // any payment with `period_end >= lastDay` settled every engagement at once:
  // another company's final pay, or an off-cycle line riding the worker's current
  // OPEN period (which ends after the last day by construction), locked out a
  // contractor whose real final stub was never run (#90). Date columns
  // ('YYYY-MM-DD') compare correctly as text.
  //
  // ponytail: containment means a final stub genuinely paid as an off-cycle line
  // on a later period never settles, so access stays open. That is the cheap
  // direction — a read-only view of their own rows outliving the money beats
  // locking out someone still owed.
  const settled = (l: { company_id: string; ended_on: string }) =>
    rows.some((p) => {
      const period = p.pay_periods;
      return (
        p.company_id === l.company_id &&
        period != null &&
        period.period_start <= l.ended_on &&
        period.period_end >= l.ended_on
      );
    });
  if (!owed.every(settled)) return true;

  // ponytail: this covers approved SESSIONS only. Approved `time_entries` have no
  // unpaid marker at all, so the check above is their only protection — company +
  // period scoping is what makes it hold now, but hours approved INTO a period
  // that already ran and landed are still invisible here. Upgrade path: stamp
  // time_entries paid the way service_sessions are, then count them here too.
  const { count, error: sErr } = await db
    .from('service_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', workerId)
    .eq('approval', 'approved')
    .is('paid_at', null);
  if (sErr) throw new Error(`unpaid sessions: ${sErr.message}`);
  return (count ?? 0) > 0;
};

/**
 * Revoke the portal login of every departed contractor whose money has landed.
 *
 * This is what makes "access ends when the money lands" true at the DB rather
 * than in this app's resolver. `my_worker_id()` — the helper every contractor
 * RLS policy resolves through — reads `contractor_logins.status = 'active'` and
 * nothing else, so flipping that column is the whole enforcement. Same value and
 * same column as revokePortalLogin: manual and automatic revocation must be
 * indistinguishable to RLS.
 *
 * Why a SWEEP and not a hook on the payment that lands: the exposed client is
 * portal.abbilabs.com and raw PostgREST, neither of which runs a line of this
 * app. A flip at resolve time only fires for someone who visits HERE, which the
 * departed contractor never has to do; a flip inside markPaid/wisePoll only
 * fires for money moved HERE, and the legacy apps stamp `paid_at` on the same
 * shared DB (#85). A scheduled pass over the DB state is the only trigger that
 * does not depend on which app acted.
 *
 * Direction is deliberate — the predicate is only ever asked to END access:
 *   * candidates are 'ended' workers with a still-active login, so an active
 *     contractor can never be touched;
 *   * `hasPayOutstanding` resolves every unknown to "still owed" and this only
 *     revokes on a hard false;
 *   * any query error throws and the sweep stops WITHOUT writing further —
 *     tomorrow's tick retries. Locking out someone still owed is the expensive
 *     mistake; a late revocation is not.
 * It never restores: it cannot tell its own revocation from an admin's
 * deliberate one, and resurrecting the latter would be a silent undo of a
 * security decision. Restoration is migration 39's trigger (reactivation) and
 * restorePortalLogin (everything else).
 *
 * Takes the SERVICE client — contractor_logins has one RLS policy and it is
 * SELECT-only, so this write lands as 0 rows under any user session.
 */
export const sunsetPortalLogins = async (
  db: Db,
): Promise<{ checked: number; revoked: string[] }> => {
  const { data: ended, error: wErr } = await db.from('workers').select('id').eq('status', 'ended');
  if (wErr) throw new Error(`ended workers: ${wErr.message}`);
  const endedIds = (ended ?? []).map((w) => w.id);
  if (endedIds.length === 0) return { checked: 0, revoked: [] };

  const { data: logins, error: lErr } = await db
    .from('contractor_logins')
    .select('worker_id')
    .eq('status', 'active')
    .in('worker_id', endedIds);
  if (lErr) throw new Error(`active contractor logins: ${lErr.message}`);

  // ponytail: serial, and it re-reads the same worker_companies/payments rows per
  // worker. The candidate set is "departed contractors who still have a login" —
  // single digits per night. Upgrade path if that ever stops being true: batch the
  // three reads once and pass slices to a pure predicate.
  const revoked: string[] = [];
  for (const { worker_id } of logins ?? []) {
    if (await hasPayOutstanding(db, worker_id)) continue;
    const { error } = await db
      .from('contractor_logins')
      .update({ status: 'revoked' })
      .eq('worker_id', worker_id)
      .eq('status', 'active');
    if (error) throw new Error(`portal login revoke: ${error.message}`);
    revoked.push(worker_id);
  }
  return { checked: (logins ?? []).length, revoked };
};

/** Wipe stored tool credentials — a terminated contractor can't be handed them. */
export const clearWorkerTools = async (db: Db, workerId: string): Promise<void> => {
  const { error } = await db
    .from('worker_tools')
    .update({ enc: null, popup_pending: false })
    .eq('worker_id', workerId);
  if (error) throw new Error(`worker_tools clear: ${error.message}`);
};
