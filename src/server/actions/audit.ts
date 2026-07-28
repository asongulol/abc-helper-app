'use server';

/**
 * Audit-log actions: the filtered CSV export, and the pay-file download record
 * that arms the cross-admin double-export guard (RP-59).
 */

import { createServerSupabase } from '@/db/clients/server';
import {
  type AuditFilters,
  getAuditLogForExport,
  PAYFILE_DOWNLOAD_ACTION,
} from '@/db/queries/audit';
import { periodBelongsToCompany } from '@/db/queries/payroll';
import { csvEscape } from '@/lib/csv';
import { humanizeError } from '@/lib/errors';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';
import { uuid } from '@/types/schemas/uuid';

type ExportResult =
  | { ok: true; data: { csv: string; filename: string } }
  | { ok: false; error: string };

export async function exportAuditCsv(filters: AuditFilters): Promise<ExportResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const companyId = await getSelectedCompanyId();
  if (!companyId) return { ok: false, error: 'No company selected or accessible.' };

  try {
    const db = await createServerSupabase();
    const rows = await getAuditLogForExport(db, companyId, filters);

    const header = ['When', 'By', 'Action', 'Item', 'Detail'].map(csvEscape).join(',');
    const lines = rows.map((r) =>
      [
        r.createdAt,
        r.actor ?? '',
        r.action,
        r.entity ?? '',
        r.detail == null ? '' : JSON.stringify(r.detail),
      ]
        .map(csvEscape)
        .join(','),
    );
    const csv = [header, ...lines].join('\n');
    const stamp =
      filters.dateFrom || filters.dateTo
        ? `${filters.dateFrom ?? 'start'}_to_${filters.dateTo ?? 'latest'}`
        : 'all';
    return { ok: true, data: { csv, filename: `audit-log_${stamp}.csv` } };
  } catch (err) {
    return { ok: false, error: humanizeError(err, 'Export failed.') };
  }
}

/**
 * Record one pay-file download, so a second admin (or another machine) sees
 * that the file has already been taken — the guard `getPayfileDownloads` reads
 * back on /process (RP-59).
 *
 * This was an inline `'use server'` function in process/page.tsx — the repo's
 * only one — that closed over the resolved ids so the client couldn't choose
 * them. Taking them as arguments instead means re-establishing that here: the
 * caller must be an admin OF the company, and the period must belong to it.
 * Best-effort by design; a failure must never block the download the admin has
 * already performed.
 */
export async function logPayfileDownload(args: {
  periodId: string;
  companyId: string;
  kind: 'wise' | 'individual';
  rows: number;
  totalPhp: number;
}): Promise<void> {
  const admin = await getCurrentAdmin();
  if (!admin) return;
  if (!uuid().safeParse(args.companyId).success) return;
  if (!admin.isOwner && !admin.companyIds.includes(args.companyId)) return;
  if (args.kind !== 'wise' && args.kind !== 'individual') return;

  try {
    const db = await createServerSupabase();
    if (!(await periodBelongsToCompany(db, args.periodId, args.companyId))) return;
    await logEvent({
      companyId: args.companyId,
      action: PAYFILE_DOWNLOAD_ACTION,
      entity: args.periodId,
      detail: {
        kind: args.kind,
        rows: Number.isFinite(args.rows) ? args.rows : 0,
        totalPhp: Number.isFinite(args.totalPhp) ? args.totalPhp : 0,
      },
    });
  } catch {
    /* best-effort: the file is already downloaded, never fail the click */
  }
}
