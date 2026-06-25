/**
 * Worker query module — ALL worker/roster DB reads and writes for the
 * contractors admin screen live here. Client passed as first arg (ADR-0002/0003).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/db/types';

type Db = SupabaseClient<Database>;
type WorkersUpdate = Database['public']['Tables']['workers']['Update'];

/** One saved Wise payout recipient (identifier only — never bank details). */
export type WiseRecipientRef = { id: number; label: string };

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
  photoUrl: string | null;
  /** Default Wise payout recipient id (also the "last used"). */
  wiseRecipientId: number | null;
  /** Wise recipient UUID — the Wise API never returns it; pasted from the Batch CSV. */
  wiseRecipientUuid: string | null;
  /** Saved Wise recipient ids + labels (identifiers only). */
  wiseRecipients: WiseRecipientRef[] | null;
  // worker_companies link fields
  linkId: string;
  companyId: string;
  contract: Database['public']['Enums']['contract_type'];
  /** PHS unit: 'hourly' | 'per_session' (else null). */
  payBasis: string | null;
  role: string | null;
  hubstaffName: string | null;
  /** Hubstaff user id for this engagement (drift-check + sync matching). */
  hubstaffUserId: number | null;
  weeklyHours: number | null;
  billRateUsd: number | null;
  sessionRateUsd: number | null;
  linkStatus: Database['public']['Enums']['worker_status'];
};

/**
 * Roster for a single company: worker_companies joined to workers, newest
 * created first. Current rate is resolved by the caller from the rates query.
 */
export const fetchRoster = async (db: Db, companyId: string): Promise<RosterWorker[]> => {
  const SEL =
    'id, worker_id, company_id, contract, pay_basis, role, hubstaff_name, hubstaff_user_id, weekly_hours, bill_rate_usd, session_rate_usd, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible, work_email, work_number, work_extension, shift_start, shift_end, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, wise_recipient_id, wise_recipient_uuid, wise_recipients, photo_url)' as const;

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
        wiseRecipients: w.wise_recipients as unknown as WiseRecipientRef[] | null,
        photoUrl: w.photo_url,
        linkId: l.id,
        companyId: l.company_id,
        contract: l.contract,
        payBasis: l.pay_basis ?? null,
        role: l.role,
        hubstaffName: l.hubstaff_name,
        hubstaffUserId: l.hubstaff_user_id,
        weeklyHours: l.weekly_hours,
        billRateUsd: l.bill_rate_usd,
        sessionRateUsd: l.session_rate_usd,
        linkStatus: l.status,
      };
    });
};

/** Fetch a single worker_companies row joined to worker, or null. */
export const fetchWorkerLink = async (
  db: Db,
  workerId: string,
  companyId: string,
): Promise<RosterWorker | null> => {
  const SEL2 =
    'id, worker_id, company_id, contract, pay_basis, role, hubstaff_name, hubstaff_user_id, weekly_hours, bill_rate_usd, session_rate_usd, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible, work_email, work_number, work_extension, shift_start, shift_end, date_of_birth, emergency_name, emergency_relationship, emergency_mobile, marital_status, education_level, course, year_graduated, school, gcash, paymaya, paypal, wise_tag, wise_recipient_id, wise_recipient_uuid, wise_recipients, photo_url)' as const;

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
    wiseRecipients: w.wise_recipients as unknown as WiseRecipientRef[] | null,
    photoUrl: w.photo_url,
    linkId: data.id,
    companyId: data.company_id,
    contract: data.contract,
    payBasis: data.pay_basis ?? null,
    role: data.role,
    hubstaffName: data.hubstaff_name,
    hubstaffUserId: data.hubstaff_user_id,
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

// ─── Wise recipient fields (legacy persist / persistUuid / pullFromWise / link) ──

export type WorkerWiseSnapshot = {
  wiseRecipientId: number | null;
  wiseRecipientUuid: string | null;
  wiseRecipients: WiseRecipientRef[];
};

/** Read a worker's current Wise recipient fields (for audit from→to + appends). */
export const fetchWorkerWiseSnapshot = async (
  db: Db,
  workerId: string,
): Promise<WorkerWiseSnapshot> => {
  const { data, error } = await db
    .from('workers')
    .select('wise_recipient_id, wise_recipient_uuid, wise_recipients')
    .eq('id', workerId)
    .maybeSingle();
  if (error) throw new Error(`workers wise read: ${error.message}`);
  return {
    wiseRecipientId: data?.wise_recipient_id ?? null,
    wiseRecipientUuid: data?.wise_recipient_uuid ?? null,
    wiseRecipients: (data?.wise_recipients as unknown as WiseRecipientRef[] | null) ?? [],
  };
};

/**
 * Patch a worker's Wise recipient identity fields. Callers build the partial
 * (recipients list, default id, UUID, pulled name/email) and this persists it.
 * `wise_recipients` is JSON, so it is cast through the column's Json type.
 */
export const updateWorkerWiseFields = async (
  db: Db,
  workerId: string,
  patch: {
    wise_recipient_id?: number | null;
    wise_recipient_uuid?: string | null;
    wise_recipients?: WiseRecipientRef[];
    first_name?: string;
    middle_name?: string | null;
    last_name?: string;
    email?: string;
  },
): Promise<void> => {
  const payload: WorkersUpdate = {};
  if ('wise_recipient_id' in patch) payload.wise_recipient_id = patch.wise_recipient_id ?? null;
  if ('wise_recipient_uuid' in patch)
    payload.wise_recipient_uuid = patch.wise_recipient_uuid ?? null;
  if (patch.wise_recipients !== undefined)
    payload.wise_recipients = patch.wise_recipients as unknown as Json;
  if (patch.first_name !== undefined) payload.first_name = patch.first_name;
  if (patch.middle_name !== undefined) payload.middle_name = patch.middle_name;
  if (patch.last_name !== undefined) payload.last_name = patch.last_name;
  if (patch.email !== undefined) payload.email = patch.email;

  const { error } = await db.from('workers').update(payload).eq('id', workerId);
  if (error) throw new Error(`workers wise update: ${error.message}`);
};
