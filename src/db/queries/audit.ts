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

/**
 * Paged audit_log, newest first; filter on action+entity text + date range.
 *
 * No `company_id` scoping here — RLS (`is_company_admin(company_id)`) already
 * scopes visible rows per admin, and NULL/client-company rows (e.g.
 * invoice_voided, portal_login.*) have no employer-company match to filter on.
 * `companyId` is kept in the signature for call-site compatibility.
 */
export const getAuditLogPage = async (
  db: Db,
  _companyId: string,
  opts: { page: number; pageSize: number } & AuditFilters,
): Promise<AuditLogPage> => {
  const { page, pageSize } = opts;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = db
    .from('audit_log')
    .select(SELECT_COLS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  query = applyAuditFilters(query, opts);

  const { data, error, count } = await query;
  if (error) throw new Error(`getAuditLogPage: ${error.message}`);

  return { rows: (data ?? []).map(mapRow), total: count ?? 0 };
};

/** `action` logged by /process when a payment file is downloaded (RP-59). */
export const PAYFILE_DOWNLOAD_ACTION = 'payfile_downloaded';

export interface PayfileDownload {
  /** Which file: 'wise' | 'individual'. */
  kind: string;
  /** ISO timestamp of the download. */
  at: string;
  /** Admin email from the audit row; null when the log didn't capture one. */
  actor: string | null;
  /** Downloaded by someone other than the admin looking at the screen. */
  byOther: boolean;
}

/**
 * Newest download record per file kind. Pure — takes raw audit rows so the
 * "is this batch already exported, and by whom" decision is unit-testable.
 * Unknown actor counts as someone else: on a double-pay guard, "not provably
 * me" must still warn.
 */
export const lastPayfileDownloads = (
  rows: readonly AuditLogRow[],
  currentActor: string | null,
): PayfileDownload[] => {
  const newest = new Map<string, AuditLogRow>();
  for (const r of rows) {
    if (r.action !== PAYFILE_DOWNLOAD_ACTION) continue;
    const d = r.detail;
    const kind = d && typeof d === 'object' && !Array.isArray(d) ? d.kind : undefined;
    if (typeof kind !== 'string') continue;
    const cur = newest.get(kind);
    // ISO-8601 timestamps compare correctly as strings.
    if (!cur || r.createdAt > cur.createdAt) newest.set(kind, r);
  }
  return [...newest].map(([kind, r]) => ({
    kind,
    at: r.createdAt,
    actor: r.actor,
    byOther: r.actor !== currentActor,
  }));
};

/**
 * Payment-file download records for one pay period, so /process can warn a
 * SECOND admin (or another machine) that the batch was already exported —
 * the case the localStorage stamp in ProcessPay structurally cannot see.
 * Reuses audit_log rather than a downloads table: same {actor, when, what}.
 */
export const getPayfileDownloads = async (
  db: Db,
  periodId: string,
  currentActor: string | null,
): Promise<PayfileDownload[]> => {
  // 20 is far more than the 2 kinds; the helper picks the newest of each.
  const { data, error } = await db
    .from('audit_log')
    .select(SELECT_COLS)
    .eq('action', PAYFILE_DOWNLOAD_ACTION)
    .eq('entity', periodId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`getPayfileDownloads: ${error.message}`);
  return lastPayfileDownloads((data ?? []).map(mapRow), currentActor);
};

/**
 * All audit rows matching the filters, newest first, for CSV export.
 * Capped (default 5000) so a runaway export can't pull the whole table.
 */
export const getAuditLogForExport = async (
  db: Db,
  _companyId: string,
  opts: AuditFilters & { max?: number } = {},
): Promise<AuditLogRow[]> => {
  const max = opts.max ?? 5000;
  let query = db
    .from('audit_log')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false })
    .limit(max);
  query = applyAuditFilters(query, opts);

  const { data, error } = await query;
  if (error) throw new Error(`getAuditLogForExport: ${error.message}`);
  return (data ?? []).map(mapRow);
};
