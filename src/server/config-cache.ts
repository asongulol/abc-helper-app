import 'server-only';
import { unstable_cache } from 'next/cache';
import { createServiceClient } from '@/db/clients/service';
import type { AgreementTemplateRow, PortalSettingsRow } from '@/db/queries/config';

/**
 * Cross-request caches for the two genuinely APP-GLOBAL config lookups — they have
 * NO per-company or per-user axis, so caching them by a fixed tag cannot leak
 * across tenants (unlike the RLS-scoped reads, which are deliberately left
 * per-request). Each is read on a hot path on every visit; without this they hit
 * Postgres on every render. Writes in src/server/actions/config.ts revalidate the
 * matching tag, so an edit is reflected immediately; `revalidate` is only a
 * backstop for out-of-band (Dashboard SQL) edits.
 *
 * The service client is used INSIDE the cache callback on purpose: `unstable_cache`
 * runs outside request scope (no cookies()), and these rows are global — the
 * service read returns the same singleton the RLS read would.
 */

export const PORTAL_SETTINGS_TAG = 'portal-settings';
export const AGREEMENT_TEMPLATES_TAG = 'agreement-templates';

/** Portal settings singleton (`portal_settings.id=1`). Read on the contractor home every visit. */
export const getCachedPortalSettings = unstable_cache(
  async (): Promise<PortalSettingsRow> => {
    const db = createServiceClient();
    const { data, error } = await db
      .from('portal_settings')
      .select('editable_fields, onboarding_config')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`portal_settings: ${error.message}`);
    return {
      editableFields: Array.isArray(data?.editable_fields)
        ? (data.editable_fields as string[])
        : [],
      onboardingConfigRaw: data?.onboarding_config ?? {},
    };
  },
  ['portal-settings'],
  { tags: [PORTAL_SETTINGS_TAG], revalidate: 3600 },
);

/** Standard agreement/contract templates (app-global, edited rarely in Config). */
export const getCachedAgreementTemplates = unstable_cache(
  async (): Promise<AgreementTemplateRow[]> => {
    const db = createServiceClient();
    const { data, error } = await db
      .from('agreement_templates')
      .select('kind, title, body, version, updated_at');
    if (error) throw new Error(`agreement_templates: ${error.message}`);
    return (data ?? []).map((r) => ({
      kind: r.kind,
      title: r.title,
      body: r.body,
      version: r.version,
      updatedAt: r.updated_at,
    }));
  },
  ['agreement-templates'],
  { tags: [AGREEMENT_TEMPLATES_TAG], revalidate: 3600 },
);
