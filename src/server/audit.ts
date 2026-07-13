import 'server-only';
import { createServerSupabase } from '@/db/clients/server';
import type { Json } from '@/db/types';

/**
 * Durable audit trail (legacy `logEvent`). Best-effort: an audit failure never
 * blocks the user action — same stance as the legacy app.
 */
export const logEvent = async (entry: {
  companyId?: string | null;
  action: string;
  entity: string;
  detail?: Json;
}): Promise<void> => {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from('audit_log').insert({
      company_id: entry.companyId ?? null,
      actor: user?.email ?? null,
      action: entry.action,
      entity: entry.entity,
      detail: entry.detail ?? null,
    });
  } catch {
    // best-effort by design
  }
};
