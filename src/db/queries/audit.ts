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

/** Paged audit_log, newest first; filter on action+entity text. */
export const getAuditLogPage = async (
  db: Db,
  companyId: string,
  opts: {
    page: number;
    pageSize: number;
    /** Case-insensitive substring filter on action or entity. */
    filter?: string;
  },
): Promise<AuditLogPage> => {
  const { page, pageSize, filter } = opts;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = db
    .from('audit_log')
    .select('id, created_at, actor, action, entity, company_id, detail', {
      count: 'exact',
    })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filter && filter.trim().length > 0) {
    const needle = filter.trim();
    // Supabase .or() with ilike on two columns
    query = query.or(`action.ilike.%${needle}%,entity.ilike.%${needle}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`getAuditLogPage: ${error.message}`);

  return {
    rows: (data ?? []).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      actor: r.actor,
      action: r.action,
      entity: r.entity,
      companyId: r.company_id,
      detail: r.detail,
    })),
    total: count ?? 0,
  };
};
