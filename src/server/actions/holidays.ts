'use server';

/**
 * Observed-holidays config actions (Configuration → Observed holidays).
 * Stored per-year on the EMPLOYER company so the set is shared across admins and
 * is read by the server-side payroll calc (resolveHolidaysForRange).
 */

import { createServerSupabase } from '@/db/clients/server';
import { fetchHolidaysConfig, updateHolidaysConfig } from '@/db/queries/holidays';
import { humanizeError } from '@/lib/errors';
import type { Holiday, HolidaysConfig } from '@/lib/pay/holidays';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getTrackerCompanyId } from '@/server/company';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function employerScope(): Promise<{ companyId: string } | { error: string }> {
  const admin = await getCurrentAdmin();
  if (!admin) return { error: 'Not signed in as an admin.' };
  const companyId = await getTrackerCompanyId();
  if (!companyId) return { error: 'No employer company configured.' };
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { error: 'No access to this company.' };
  }
  return { companyId };
}

export async function loadHolidays(): Promise<Result<{ config: HolidaysConfig }>> {
  const scope = await employerScope();
  if ('error' in scope) return { ok: false, error: scope.error };
  try {
    const db = await createServerSupabase();
    const config = await fetchHolidaysConfig(db, scope.companyId);
    return { ok: true, data: { config } };
  } catch (e) {
    return { ok: false, error: humanizeError(e, 'Load failed.') };
  }
}

/** Replace the effective holiday set for one year (the editor saves per year). */
export async function saveHolidaysForYear(args: {
  year: number;
  holidays: Holiday[];
}): Promise<Result<{ config: HolidaysConfig }>> {
  const scope = await employerScope();
  if ('error' in scope) return { ok: false, error: scope.error };

  const year = Number(args.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: 'Invalid year.' };
  }
  if (!Array.isArray(args.holidays)) return { ok: false, error: 'Invalid holidays.' };

  // Sanitize: well-formed {date,name} for THIS year only, deduped + sorted.
  const seen = new Set<string>();
  const clean: Holiday[] = [];
  for (const h of args.holidays) {
    const date = String(h?.date ?? '').trim();
    const name = String(h?.name ?? '').trim();
    if (!ISO.test(date) || !name || seen.has(date) || date.slice(0, 4) !== String(year)) continue;
    seen.add(date);
    clean.push({ date, name });
  }
  clean.sort((a, b) => a.date.localeCompare(b.date));

  try {
    const db = await createServerSupabase();
    const config = await fetchHolidaysConfig(db, scope.companyId);
    config[String(year)] = clean;
    await updateHolidaysConfig(db, scope.companyId, config);
    await logEvent({
      companyId: scope.companyId,
      action: 'edit_holidays',
      entity: String(year),
      detail: { count: clean.length },
    });
    return { ok: true, data: { config } };
  } catch (e) {
    return { ok: false, error: humanizeError(e, 'Save failed.') };
  }
}
