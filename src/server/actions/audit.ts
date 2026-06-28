'use server';

/**
 * Audit-log export action. Read-only: pulls the filtered audit rows and returns
 * a CSV string the client downloads. Legacy column labels (When / By / Action /
 * Item / Detail).
 */

import { createServerSupabase } from '@/db/clients/server';
import { type AuditFilters, getAuditLogForExport } from '@/db/queries/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import { getSelectedCompanyId } from '@/server/company';

type ExportResult =
  | { ok: true; data: { csv: string; filename: string } }
  | { ok: false; error: string };

const esc = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function exportAuditCsv(filters: AuditFilters): Promise<ExportResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const companyId = await getSelectedCompanyId();
  if (!companyId) return { ok: false, error: 'No company selected or accessible.' };

  try {
    const db = await createServerSupabase();
    const rows = await getAuditLogForExport(db, companyId, filters);

    const header = ['When', 'By', 'Action', 'Item', 'Detail'].map(esc).join(',');
    const lines = rows.map((r) =>
      [
        r.createdAt,
        r.actor ?? '',
        r.action,
        r.entity ?? '',
        r.detail == null ? '' : JSON.stringify(r.detail),
      ]
        .map((c) => esc(String(c)))
        .join(','),
    );
    const csv = [header, ...lines].join('\n');
    const stamp =
      filters.dateFrom || filters.dateTo
        ? `${filters.dateFrom ?? 'start'}_to_${filters.dateTo ?? 'latest'}`
        : 'all';
    return { ok: true, data: { csv, filename: `audit-log_${stamp}.csv` } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Export failed.' };
  }
}
