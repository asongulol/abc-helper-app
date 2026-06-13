/**
 * Worker query module — ALL worker/roster DB reads and writes for the
 * contractors admin screen live here. Client passed as first arg (ADR-0002/0003).
 */

import 'server-only';
import type { Database } from '@/db/types';
import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient<Database>;

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
  // worker_companies link fields
  linkId: string;
  companyId: string;
  contract: Database['public']['Enums']['contract_type'];
  role: string | null;
  hubstaffName: string | null;
  weeklyHours: number | null;
  linkStatus: Database['public']['Enums']['worker_status'];
};

/**
 * Roster for a single company: worker_companies joined to workers, newest
 * created first. Current rate is resolved by the caller from the rates query.
 */
export const fetchRoster = async (db: Db, companyId: string): Promise<RosterWorker[]> => {
  const SEL =
    'id, worker_id, company_id, contract, role, hubstaff_name, weekly_hours, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible)' as const;

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
        linkId: l.id,
        companyId: l.company_id,
        contract: l.contract,
        role: l.role,
        hubstaffName: l.hubstaff_name,
        weeklyHours: l.weekly_hours,
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
    'id, worker_id, company_id, contract, role, hubstaff_name, weekly_hours, status, workers(id, first_name, middle_name, last_name, email, mobile, ph_address, permanent_address, address_landmark, postal_code, hire_date, status, payout_method, health_allowance_eligible, thirteenth_month_eligible)' as const;

  const { data, error } = await db
    .from('worker_companies')
    .select(SEL2)
    .eq('worker_id', workerId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw new Error(`worker_companies: ${error.message}`);
  if (!data || !data.workers) return null;
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
    linkId: data.id,
    companyId: data.company_id,
    contract: data.contract,
    role: data.role,
    hubstaffName: data.hubstaff_name,
    weeklyHours: data.weekly_hours,
    linkStatus: data.status,
  };
};

/** Insert a new worker and link row. Returns the new worker_id. */
export const insertWorkerWithLink = async (
  db: Db,
  args: {
    firstName: string;
    lastName: string;
    companyId: string;
    contract: Database['public']['Enums']['contract_type'];
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
    role: string | null;
    hubstaff_name: string | null;
    weekly_hours: number | null;
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
