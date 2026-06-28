/**
 * Company observed-holidays config — reads/writes companies.holidays_config
 * (per-year override consumed by the payroll expected-hours calc).
 * Caller passes an already-created SupabaseClient (ADR-0002/0003).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import type { HolidaysConfig } from '@/lib/pay/holidays';

type Db = SupabaseClient<Database>;

export const fetchHolidaysConfig = async (db: Db, companyId: string): Promise<HolidaysConfig> => {
  const { data, error } = await db
    .from('companies')
    .select('holidays_config')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new Error(`holidays_config: ${error.message}`);
  return ((data?.holidays_config ?? {}) as HolidaysConfig) || {};
};

/** Replace the whole config blob (caller merges the edited year in first). */
export const updateHolidaysConfig = async (
  db: Db,
  companyId: string,
  config: HolidaysConfig,
): Promise<void> => {
  const { error } = await db
    .from('companies')
    .update({ holidays_config: config })
    .eq('id', companyId);
  if (error) throw new Error(`holidays_config update: ${error.message}`);
};
