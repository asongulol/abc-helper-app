/**
 * Admins query module — DB reads/writes for /config admin management.
 * Callers supply a SupabaseClient; privileged mutations use the service client
 * ONLY after an explicit owner check in the server action layer.
 */

import 'server-only';
import type { Database } from '@/db/types';
import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient<Database>;

export interface AdminRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  canCountersign: boolean;
  addedAt: string;
  addedBy: string | null;
  /** Company IDs scoped to this admin (empty = owner / all). */
  companyIds: string[];
}

/**
 * List all admin_users with their company scope.
 * Uses the RLS user client — an admin only sees rows visible to them per policy.
 */
export const listAdmins = async (db: Db): Promise<AdminRow[]> => {
  const { data: users, error: userError } = await db
    .from('admin_users')
    .select('user_id, email, name, role, can_countersign, added_at, added_by')
    .order('added_at', { ascending: true });
  if (userError) throw new Error(`listAdmins users: ${userError.message}`);

  const { data: scopes, error: scopeError } = await db
    .from('admin_companies')
    .select('admin_email, company_id');
  if (scopeError) throw new Error(`listAdmins scopes: ${scopeError.message}`);

  // Build a lookup: email → company_id[]
  const scopeMap = new Map<string, string[]>();
  for (const s of scopes ?? []) {
    const existing = scopeMap.get(s.admin_email) ?? [];
    existing.push(s.company_id);
    scopeMap.set(s.admin_email, existing);
  }

  return (users ?? []).map((u) => ({
    userId: u.user_id,
    email: u.email,
    name: u.name,
    role: u.role,
    canCountersign: u.can_countersign,
    addedAt: u.added_at,
    addedBy: u.added_by,
    companyIds: scopeMap.get(u.email) ?? [],
  }));
};
