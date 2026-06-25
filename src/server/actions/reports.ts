'use server';

/**
 * Reports server actions. The per-payment detail export needs a server-only
 * query (RLS user client), so the client component fetches the rows through
 * this action and builds the CSV in the browser.
 */

import { z } from 'zod';
import { createServerSupabase } from '@/db/clients/server';
import { fetchReportPayments, type ReportPaymentRow } from '@/db/queries/reports';
import type { ActionResult } from '@/server/actions/portal-admin';
import { getCurrentAdmin } from '@/server/auth/admin';
import { IsoDateSchema } from '@/types/schemas/payroll';
import { uuid } from '@/types/schemas/uuid';

const DetailExportSchema = z.object({
  companyId: uuid(),
  fromDate: IsoDateSchema,
  toDate: IsoDateSchema,
});

/** Payment-level rows for the detail CSV export, scoped to the admin's company. */
export async function getReportDetail(
  args: unknown,
): Promise<ActionResult<{ rows: ReportPaymentRow[] }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const parsed = DetailExportSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const { companyId, fromDate, toDate } = parsed.data;
  if (!admin.isOwner && !admin.companyIds.includes(companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  try {
    const db = await createServerSupabase();
    const rows = await fetchReportPayments(db, companyId, fromDate, toDate);
    return { ok: true, data: { rows } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Export failed.',
    };
  }
}
