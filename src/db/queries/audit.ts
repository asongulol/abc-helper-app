/**
 * Audit query module — all DB reads for the /audit page.
 * Callers pass an already-created SupabaseClient (RLS user client).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/db/types';

type Db = SupabaseClient<Database>;

export interface AuditLogRow {
  id: string;
  createdAt: string;
  actor: string | null;
  action: string;
  entity: string | null;
  companyId: string | null;
  detail: Json | null;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  /** Total count without pagination (for pager UI). */
  total: number;
}

/** Shared filters for the audit log: text (action/entity) + a created_at date range. */
export interface AuditFilters {
  /** Case-insensitive substring filter on action or entity. */
  filter?: string;
  /** Inclusive ISO date (YYYY-MM-DD) lower bound on created_at. */
  dateFrom?: string;
  /** Inclusive ISO date (YYYY-MM-DD) upper bound on created_at. */
  dateTo?: string;
}

const SELECT_COLS = 'id, created_at, actor, action, entity, company_id, detail';

/** Apply the shared text + date-range filters to an audit_log query. */
const applyAuditFilters = <
  Q extends {
    or: (s: string) => Q;
    gte: (c: string, v: string) => Q;
    lte: (c: string, v: string) => Q;
  },
>(
  query: Q,
  { filter, dateFrom, dateTo }: AuditFilters,
): Q => {
  if (filter && filter.trim().length > 0) {
    const needle = filter.trim();
    query = query.or(`action.ilike.%${needle}%,entity.ilike.%${needle}%`);
  }
  if (dateFrom) query = query.gte('created_at', dateFrom);
  // Upper bound is inclusive of the whole day.
  if (dateTo) query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);
  return query;
};

const mapRow = (r: {
  id: string;
  created_at: string;
  actor: string | null;
  action: string;
  entity: string | null;
  company_id: string | null;
  detail: Json | null;
}): AuditLogRow => ({
  id: r.id,
  createdAt: r.created_at,
  actor: r.actor,
  action: r.action,
  entity: r.entity,
  companyId: r.company_id,
  detail: r.detail,
});

/** Paged audit_log, newest first; filter on action+entity text + date range. */
export const getAuditLogPage = async (
  db: Db,
  companyId: string,
  opts: { page: number; pageSize: number } & AuditFilters,
): Promise<AuditLogPage> => {
  const { page, pageSize } = opts;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = db
    .from('audit_log')
    .select(SELECT_COLS, { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(from, to);
  query = applyAuditFilters(query, opts);

  const { data, error, count } = await query;
  if (error) throw new Error(`getAuditLogPage: ${error.message}`);

  return { rows: (data ?? []).map(mapRow), total: count ?? 0 };
};

/**
 * All audit rows matching the filters, newest first, for CSV export.
 * Capped (default 5000) so a runaway export can't pull the whole table.
 */
export const getAuditLogForExport = async (
  db: Db,
  companyId: string,
  opts: AuditFilters & { max?: number } = {},
): Promise<AuditLogRow[]> => {
  const max = opts.max ?? 5000;
  let query = db
    .from('audit_log')
    .select(SELECT_COLS)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(max);
  query = applyAuditFilters(query, opts);

  const { data, error } = await query;
  if (error) throw new Error(`getAuditLogForExport: ${error.message}`);
  return (data ?? []).map(mapRow);
};
