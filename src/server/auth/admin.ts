import 'server-only';
import { createServerSupabase } from '@/db/clients/server';

export interface CurrentAdmin {
  userId: string;
  email: string;
  name: string | null;
  /** 'owner' | 'admin' (legacy admin_users.role). */
  role: string;
  canCountersign: boolean;
  /** Companies this admin may see (empty for owner = sees all). */
  companyIds: string[];
  isOwner: boolean;
}

/**
 * Resolve the authenticated admin (admin_users row + admin_companies scope), or
 * null. RLS-scoped client: an admin only reads their own row. The proxy gate is
 * the first line of defense; this is re-verification at point of use (ADR-0004).
 */
export const getCurrentAdmin = async (): Promise<CurrentAdmin | null> => {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: row } = await supabase
    .from('admin_users')
    .select('user_id, email, name, role, can_countersign')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!row) return null;

  const isOwner = row.role === 'owner';
  let companyIds: string[] = [];
  if (!isOwner) {
    const { data: scope } = await supabase
      .from('admin_companies')
      .select('company_id')
      .eq('admin_email', row.email);
    companyIds = (scope ?? []).map((s) => s.company_id);
  }

  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    canCountersign: row.can_countersign,
    companyIds,
    isOwner,
  };
};

/** Throwing variant for server actions: verified admin or an Error. */
export const requireAdmin = async (): Promise<CurrentAdmin> => {
  const admin = await getCurrentAdmin();
  if (!admin) throw new Error('Not authorized — admin access required.');
  return admin;
};

/** Owner-only actions (e.g. Wise money staging) per the legacy auth gates. */
export const requireOwner = async (): Promise<CurrentAdmin> => {
  const admin = await requireAdmin();
  if (!admin.isOwner) throw new Error('Not authorized — owner role required.');
  return admin;
};
