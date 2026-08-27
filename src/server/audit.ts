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
    const { error } = await supabase.from('audit_log').insert({
      company_id: entry.companyId ?? null,
      actor: user?.email ?? null,
      action: entry.action,
      entity: entry.entity,
      detail: entry.detail ?? null,
    });
    // Still best-effort — but not silent. A rejected insert used to vanish
    // entirely: the RLS INSERT policy is `is_company_admin(company_id)`, which
    // for a NULL company_id is just `is_owner()`, so every scoped admin's row
    // was dropped without a trace (#93). Callers pass a companyId now; this is
    // the tripwire for the next one that forgets.
    // biome-ignore lint/suspicious/noConsole: a vanished audit row has to leave a trace somewhere
    if (error) console.error(`audit_log insert dropped (${entry.action}): ${error.message}`);
  } catch {
    // best-effort by design
  }
};
