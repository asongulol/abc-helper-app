'use server';

/**
 * Configuration actions — admin writes for the Configuration page panels.
 * Convention (ADR-0004): verify admin role → Zod validate → service-client
 * write (bypasses RLS after the explicit role check) → audit log →
 * revalidatePath('/config').
 *
 * Auth gates:
 *   most writes        → requireAdmin()
 *   deleteClient       → requireOwner() + usage guard + typed-name confirm
 */

import { createServiceClient } from '@/db/clients/service';
import { companyUsageCounts, parseOnboardingConfig } from '@/db/queries/config';
import type { Json } from '@/db/types';
import { EDITABLE_FIELD_KEYS } from '@/lib/config/fields';
import { logEvent } from '@/server/audit';
import { requireAdmin, requireOwner } from '@/server/auth/admin';
import { fetchHubstaffProjects, getAccessToken } from '@/server/hubstaff/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export type ActionResult<T = undefined> = [T] extends [undefined]
  ? { ok: true; message?: string } | { ok: false; error: string }
  : { ok: true; data: T; message?: string } | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e ?? 'Unknown error'),
});

// ─── shared schemas ─────────────────────────────────────────────────────────────

const ContactSchema = z.object({
  first_name: z.string().trim().optional().default(''),
  last_name: z.string().trim().optional().default(''),
  title: z.string().trim().optional().default(''),
  email: z.string().trim().optional().default(''),
  mobile: z.string().trim().optional().default(''),
  extension: z.string().trim().optional().default(''),
  fax: z.string().trim().optional().default(''),
});

const CompanyFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required.'),
  hubstaffOrgId: z.number().int().positive().nullable().optional(),
  taxId: z.string().trim().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  website: z.string().trim().nullable().optional(),
  contacts: z.array(ContactSchema).optional().default([]),
});

const nz = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

// ─── Employer ───────────────────────────────────────────────────────────────────

/** Edit the single employer (`kind='employer'`), or create the first one. */
export async function saveEmployer(args: {
  id?: string;
  name: string;
  hubstaffOrgId?: number | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  contacts?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const admin = await requireAdmin();
    const parsed = CompanyFieldsSchema.safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');
    const v = parsed.data;
    const db = createServiceClient();

    const row = {
      name: v.name,
      hubstaff_org_id: v.hubstaffOrgId ?? null,
      tax_id: nz(v.taxId),
      address: nz(v.address),
      phone: nz(v.phone),
      website: nz(v.website),
      contacts: v.contacts,
      kind: 'employer' as const,
    };

    if (args.id) {
      const { error } = await db.from('companies').update(row).eq('id', args.id);
      if (error) return fail(error.message);
      await logEvent({
        action: 'config.employer_updated',
        entity: args.id,
        detail: { by: admin.email },
      });
      revalidatePath('/config');
      return { ok: true, data: { id: args.id } };
    }

    // Create only when no employer exists yet (one employer by convention).
    const { data: existing } = await db
      .from('companies')
      .select('id')
      .eq('kind', 'employer')
      .limit(1);
    if (existing && existing.length > 0) {
      return fail('An employer already exists — edit it instead of creating a second one.');
    }
    const { data, error } = await db.from('companies').insert(row).select('id').single();
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.employer_created',
      entity: data.id,
      detail: { by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    return fail(e);
  }
}

// ─── Clients ────────────────────────────────────────────────────────────────────

/** Create (omit id) or edit a client company. */
export async function saveClient(args: {
  id?: string;
  name: string;
  hubstaffOrgId?: number | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  contacts?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const admin = await requireAdmin();
    const parsed = CompanyFieldsSchema.safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input');
    const v = parsed.data;
    const db = createServiceClient();

    const row = {
      name: v.name,
      hubstaff_org_id: v.hubstaffOrgId ?? null,
      tax_id: nz(v.taxId),
      address: nz(v.address),
      phone: nz(v.phone),
      website: nz(v.website),
      contacts: v.contacts,
      kind: 'client' as const,
    };

    if (args.id) {
      const { error } = await db.from('companies').update(row).eq('id', args.id);
      if (error) return fail(error.message);
      await logEvent({
        action: 'config.client_updated',
        entity: args.id,
        detail: { by: admin.email },
      });
      revalidatePath('/config');
      return { ok: true, data: { id: args.id } };
    }
    const { data, error } = await db.from('companies').insert(row).select('id').single();
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.client_created',
      entity: data.id,
      detail: { by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    return fail(e);
  }
}

/** Archive / unarchive a client (status active|inactive). */
export async function setClientStatus(args: {
  id: string;
  status: 'active' | 'inactive';
}): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!args.id) return fail('Client id required.');
    const status = args.status === 'inactive' ? 'inactive' : 'active';
    const db = createServiceClient();
    const { error } = await db
      .from('companies')
      .update({ status })
      .eq('id', args.id)
      .eq('kind', 'client');
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.client_status',
      entity: args.id,
      detail: { status, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Permanent client delete — OWNER only. Refuses when any payroll/billing record
 * references the company (the FK is ON DELETE CASCADE, so this guard is the only
 * safeguard against silent history loss). The UI's typed-name confirm is a
 * courtesy gate; the server re-verifies the name.
 */
export async function deleteClient(args: {
  id: string;
  confirmName: string;
}): Promise<ActionResult> {
  try {
    const admin = await requireOwner();
    if (!args.id) return fail('Client id required.');
    const db = createServiceClient();

    const { data: company, error: cErr } = await db
      .from('companies')
      .select('id, name, kind')
      .eq('id', args.id)
      .maybeSingle();
    if (cErr) return fail(cErr.message);
    if (!company) return fail('Client not found.');
    if (company.kind !== 'client') return fail('Only client companies can be deleted.');

    if ((args.confirmName ?? '').trim().toLowerCase() !== company.name.trim().toLowerCase()) {
      return fail('Typed name does not match the client name.');
    }

    const usage = await companyUsageCounts(db, args.id);
    if (usage.total > 0) {
      const parts: string[] = [];
      if (usage.payPeriods) parts.push(`${usage.payPeriods} pay period(s)`);
      if (usage.timeEntries) parts.push(`${usage.timeEntries} time entr(ies)`);
      if (usage.rates) parts.push(`${usage.rates} rate(s)`);
      if (usage.links) parts.push(`${usage.links} contractor link(s)`);
      if (usage.invoices) parts.push(`${usage.invoices} invoice(s)`);
      return fail(
        `This client has ${parts.join(', ')} — archive it instead. Permanent delete is only for empty clients.`,
      );
    }

    const { error } = await db.from('companies').delete().eq('id', args.id).eq('kind', 'client');
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.client_deleted',
      entity: args.id,
      detail: { name: company.name, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Portal — editable fields ────────────────────────────────────────────────────

/** Save the set of profile fields contractors may self-edit (manifest 25). */
export async function setEditableFields(args: { fields: string[] }): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const fields = Array.from(new Set(args.fields)).filter((k) => EDITABLE_FIELD_KEYS.has(k));
    const db = createServiceClient();
    const { error } = await db
      .from('portal_settings')
      .update({ editable_fields: fields, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.editable_fields',
      entity: 'portal_settings',
      detail: { count: fields.length, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Agreement templates ─────────────────────────────────────────────────────────

const AGREEMENT_KINDS = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'] as const;

export async function saveAgreementTemplate(args: {
  kind: (typeof AGREEMENT_KINDS)[number];
  title: string;
  body: string;
  version?: string;
}): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!AGREEMENT_KINDS.includes(args.kind)) return fail('Unknown agreement kind.');
    const db = createServiceClient();
    const { error } = await db.from('agreement_templates').upsert(
      {
        kind: args.kind,
        title: (args.title ?? '').trim() || args.kind,
        body: args.body ?? '',
        version: (args.version ?? '').trim() || '1.0',
        updated_by: admin.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'kind' },
    );
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.agreement_template',
      entity: args.kind,
      detail: { by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Hubstaff projects → clients ─────────────────────────────────────────────────

/**
 * Live-load projects from the employer's Hubstaff org and upsert them. NEW
 * projects default to the employer (the sync company); existing project→client
 * assignments are preserved.
 */
export async function loadHubstaffProjects(): Promise<ActionResult<{ count: number }>> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();

    const { data: employer } = await db
      .from('companies')
      .select('id, hubstaff_org_id')
      .eq('kind', 'employer')
      .maybeSingle();
    if (!employer) return fail('No employer configured.');
    if (!employer.hubstaff_org_id)
      return fail('The employer has no Hubstaff org ID — set it in the Employer panel first.');

    const token = await getAccessToken();
    const projects = await fetchHubstaffProjects(employer.hubstaff_org_id, token);
    if (projects.length === 0) return { ok: true, data: { count: 0 } };

    const { data: existing } = await db
      .from('hubstaff_projects')
      .select('hubstaff_project_id, company_id');
    const assigned = new Map((existing ?? []).map((r) => [r.hubstaff_project_id, r.company_id]));

    const rows = projects.map((p) => ({
      hubstaff_project_id: p.id,
      name: p.name,
      org_id: employer.hubstaff_org_id,
      company_id: assigned.get(p.id) ?? employer.id,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db
      .from('hubstaff_projects')
      .upsert(rows, { onConflict: 'hubstaff_project_id' });
    if (error) return fail(error.message);

    await logEvent({
      action: 'config.hubstaff_projects_loaded',
      entity: String(employer.hubstaff_org_id),
      detail: { count: rows.length, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true, data: { count: rows.length } };
  } catch (e) {
    return fail(e);
  }
}

/** Assign a Hubstaff project to a client (or back to the employer). */
export async function assignHubstaffProject(args: {
  hubstaffProjectId: number;
  companyId: string;
}): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!args.companyId) return fail('Company id required.');
    const db = createServiceClient();
    const { error } = await db
      .from('hubstaff_projects')
      .update({ company_id: args.companyId, updated_at: new Date().toISOString() })
      .eq('hubstaff_project_id', args.hubstaffProjectId);
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.hubstaff_project_assigned',
      entity: String(args.hubstaffProjectId),
      detail: { company_id: args.companyId, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Onboarding configuration ────────────────────────────────────────────────────

/**
 * Save onboarding configuration. READ-MERGE-WRITE: the parsed config is merged
 * back over the raw singleton so unknown keys and `profile_tabs` survive.
 */
export async function saveOnboardingConfig(args: {
  config: unknown;
}): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();

    const { data: current } = await db
      .from('portal_settings')
      .select('onboarding_config')
      .eq('id', 1)
      .maybeSingle();

    const rawCurrent =
      current?.onboarding_config && typeof current.onboarding_config === 'object'
        ? (current.onboarding_config as Record<string, unknown>)
        : {};

    // Normalize the incoming config, then merge over the existing raw object.
    const next = parseOnboardingConfig(args.config);
    const merged = { ...rawCurrent, ...next };

    const { error } = await db
      .from('portal_settings')
      .update({
        onboarding_config: merged as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.onboarding_saved',
      entity: 'portal_settings',
      detail: { enabled: next.onboarding_enabled, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Announcements ───────────────────────────────────────────────────────────────

export async function postAnnouncement(args: {
  id?: string;
  title: string;
  body?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const admin = await requireAdmin();
    const title = (args.title ?? '').trim();
    if (!title) return fail('Title is required.');
    const body = nz(args.body);
    const db = createServiceClient();

    if (args.id) {
      const { error } = await db.from('announcements').update({ title, body }).eq('id', args.id);
      if (error) return fail(error.message);
      await logEvent({
        action: 'config.announcement_updated',
        entity: args.id,
        detail: { by: admin.email },
      });
      revalidatePath('/config');
      return { ok: true, data: { id: args.id } };
    }
    const { data, error } = await db
      .from('announcements')
      .insert({ title, body, author: admin.name ?? admin.email, active: true })
      .select('id')
      .single();
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.announcement_posted',
      entity: data.id,
      detail: { by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    return fail(e);
  }
}

/** Hide / show an announcement on the portal home. */
export async function setAnnouncementActive(args: {
  id: string;
  active: boolean;
}): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const { error } = await db
      .from('announcements')
      .update({ active: args.active })
      .eq('id', args.id);
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.announcement_active',
      entity: args.id,
      detail: { active: args.active, by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAnnouncement(args: { id: string }): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const db = createServiceClient();
    const { error } = await db.from('announcements').delete().eq('id', args.id);
    if (error) return fail(error.message);
    await logEvent({
      action: 'config.announcement_deleted',
      entity: args.id,
      detail: { by: admin.email },
    });
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
