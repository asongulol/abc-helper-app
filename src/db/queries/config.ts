/**
 * Configuration query module — admin reads for the Configuration page panels
 * (companies/employer, clients, hubstaff projects, agreement templates,
 * portal settings, announcements). Follows the repo convention: `server-only`,
 * `(db, …)` first arg, throw on error, return mapped camelCase rows.
 *
 * The privileged writes live in `src/server/actions/config.ts`.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/db/types';
import { DEFAULT_HIRE_EMAILS } from '@/server/email/templates';

type Db = SupabaseClient<Database>;

// ─── Companies (employer + clients) ─────────────────────────────────────────────

export interface CompanyContact {
  first_name?: string;
  last_name?: string;
  title?: string;
  email?: string;
  mobile?: string;
  extension?: string;
  fax?: string;
}

export interface CompanyFullRow {
  id: string;
  name: string;
  /** 'employer' | 'client'. */
  kind: string;
  status: Database['public']['Enums']['company_status'];
  hubstaffOrgId: number | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  contacts: CompanyContact[];
}

const COMPANY_COLS =
  'id, name, kind, status, hubstaff_org_id, tax_id, address, phone, website, contacts';

const mapCompany = (r: {
  id: string;
  name: string;
  kind: string;
  status: Database['public']['Enums']['company_status'];
  hubstaff_org_id: number | null;
  tax_id: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  contacts: unknown;
}): CompanyFullRow => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  status: r.status,
  hubstaffOrgId: r.hubstaff_org_id,
  taxId: r.tax_id,
  address: r.address,
  phone: r.phone,
  website: r.website,
  contacts: Array.isArray(r.contacts) ? (r.contacts as CompanyContact[]) : [],
});

/** The single employer company (`kind='employer'`), or null on a fresh DB. */
export const getEmployer = async (db: Db): Promise<CompanyFullRow | null> => {
  const { data, error } = await db
    .from('companies')
    .select(COMPANY_COLS)
    .eq('kind', 'employer')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`employer: ${error.message}`);
  return data ? mapCompany(data) : null;
};

/** Client companies (billing targets), newest-active first. */
export const listClients = async (
  db: Db,
  opts?: { activeOnly?: boolean },
): Promise<CompanyFullRow[]> => {
  let q = db.from('companies').select(COMPANY_COLS).eq('kind', 'client');
  if (opts?.activeOnly) q = q.eq('status', 'active');
  const { data, error } = await q.order('name', { ascending: true });
  if (error) throw new Error(`clients: ${error.message}`);
  return (data ?? []).map(mapCompany);
};

/** Every company (employer first), for cross-referencing in the panels. */
export const listCompaniesFull = async (db: Db): Promise<CompanyFullRow[]> => {
  const { data, error } = await db
    .from('companies')
    .select(COMPANY_COLS)
    .order('kind', { ascending: true }) // 'client' < 'employer' alpha → employer last; reorder below
    .order('name', { ascending: true });
  if (error) throw new Error(`companies: ${error.message}`);
  const rows = (data ?? []).map(mapCompany);
  // Employer first.
  return rows.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'employer' ? -1 : 1,
  );
};

export interface CompanyUsageCounts {
  payPeriods: number;
  timeEntries: number;
  rates: number;
  links: number;
  invoices: number;
  total: number;
}

/**
 * Count the records that block a permanent client delete (manifest 30: "no
 * payments, pay periods, time, rates, or contractor links"). The companies FK
 * is ON DELETE CASCADE, so this action-level guard is the only safeguard.
 */
export const companyUsageCounts = async (
  db: Db,
  companyId: string,
): Promise<CompanyUsageCounts> => {
  const head = (
    table: 'pay_periods' | 'time_entries' | 'rates' | 'worker_companies' | 'invoices',
  ) =>
    db.from(table).select('company_id', { count: 'exact', head: true }).eq('company_id', companyId);

  const [pp, te, rt, lk, inv] = await Promise.all([
    head('pay_periods'),
    head('time_entries'),
    head('rates'),
    head('worker_companies'),
    head('invoices'),
  ]);
  const payPeriods = pp.count ?? 0;
  const timeEntries = te.count ?? 0;
  const rates = rt.count ?? 0;
  const links = lk.count ?? 0;
  const invoices = inv.count ?? 0;
  return {
    payPeriods,
    timeEntries,
    rates,
    links,
    invoices,
    total: payPeriods + timeEntries + rates + links + invoices,
  };
};

// ─── Agreement templates ────────────────────────────────────────────────────────

export interface AgreementTemplateRow {
  kind: Database['public']['Enums']['agreement_kind'];
  title: string;
  body: string;
  version: string;
  updatedAt: string;
}

// (Reads go through the cross-request cache: getCachedAgreementTemplates in
// src/server/config-cache.ts — templates are app-global and edited rarely.)

// ─── Hubstaff projects → client mapping ─────────────────────────────────────────

export interface HubstaffProjectRow {
  hubstaffProjectId: number;
  name: string | null;
  orgId: number | null;
  companyId: string;
  updatedAt: string;
}

export const listHubstaffProjects = async (db: Db): Promise<HubstaffProjectRow[]> => {
  const { data, error } = await db
    .from('hubstaff_projects')
    .select('hubstaff_project_id, name, org_id, company_id, updated_at')
    .order('name', { ascending: true });
  if (error) throw new Error(`hubstaff_projects: ${error.message}`);
  return (data ?? []).map((r) => ({
    hubstaffProjectId: r.hubstaff_project_id,
    name: r.name,
    orgId: r.org_id,
    companyId: r.company_id,
    updatedAt: r.updated_at,
  }));
};

// ─── Announcements (admin sees all, including hidden) ───────────────────────────

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string | null;
  author: string | null;
  active: boolean;
  publishedAt: string;
}

export const listAnnouncementsAll = async (db: Db): Promise<AnnouncementRow[]> => {
  const { data, error } = await db
    .from('announcements')
    .select('id, title, body, author, active, published_at')
    .order('published_at', { ascending: false });
  if (error) throw new Error(`announcements: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    author: r.author,
    active: r.active,
    publishedAt: r.published_at,
  }));
};

// ─── Portal settings (editable fields + onboarding config) ──────────────────────

export interface OnbDocument {
  kind: string;
  title: string;
  required: boolean;
  /** Present (e.g. ['front','back']) when a doc collects both sides. */
  sides?: string[];
  /** Months until the document expires and must be re-collected. */
  freshness_months?: number;
}

export interface OnbAgreement {
  kind: string;
  order: number;
  title: string;
  version?: string;
  required: boolean;
}

export type SigMethod = 'both' | 'typed' | 'drawn';

export interface OnbSignatureMethods {
  contractor: SigMethod;
  countersigner: SigMethod;
}

export interface OnbEmail {
  subject: string;
  html: string;
}

export interface OnbEmails {
  auto_send: boolean;
  portal_url: string;
  wise_referral_url: string;
  welcome: OnbEmail;
  /** Tool-access email (sent on completion). */
  tools: OnbEmail;
  /** Password-reset / re-issue email (manifest 27 "Password-reset email"). */
  credentials: OnbEmail;
}

export interface OnbReminders {
  enabled: boolean;
  include_deferred: boolean;
  frequency: 'daily' | 'weekdays' | 'weekly';
  send_to: string[];
}

export interface OnboardingConfig {
  onboarding_enabled: boolean;
  documents: OnbDocument[];
  agreements: OnbAgreement[];
  profile_tabs: string[];
  signature_methods: OnbSignatureMethods;
  emails: OnbEmails;
  reminders: OnbReminders;
}

const defaultEmails = (): OnbEmails => ({
  auto_send: DEFAULT_HIRE_EMAILS.auto_send,
  portal_url: DEFAULT_HIRE_EMAILS.portal_url,
  wise_referral_url: DEFAULT_HIRE_EMAILS.wise_referral_url,
  welcome: { ...DEFAULT_HIRE_EMAILS.welcome },
  tools: { ...DEFAULT_HIRE_EMAILS.tools },
  credentials: { ...DEFAULT_HIRE_EMAILS.credentials },
});

/**
 * Normalize the raw `portal_settings.onboarding_config` jsonb into a fully-keyed
 * `OnboardingConfig`, filling the additive keys (signature_methods / emails /
 * reminders) from sensible defaults when the stored singleton predates them.
 * Callers should READ-MERGE-WRITE against the raw object to avoid dropping
 * `profile_tabs` or unknown keys.
 */
export const parseOnboardingConfig = (raw: unknown): OnboardingConfig => {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const sig = (o.signature_methods ?? {}) as Partial<OnbSignatureMethods>;
  const rem = (o.reminders ?? {}) as Partial<OnbReminders>;
  return {
    onboarding_enabled: o.onboarding_enabled === true,
    documents: Array.isArray(o.documents) ? (o.documents as OnbDocument[]) : [],
    agreements: Array.isArray(o.agreements) ? (o.agreements as OnbAgreement[]) : [],
    profile_tabs: Array.isArray(o.profile_tabs)
      ? (o.profile_tabs as string[])
      : ['contact', 'personal', 'payout', 'about'],
    signature_methods: {
      contractor: sig.contractor ?? 'both',
      countersigner: sig.countersigner ?? 'both',
    },
    emails:
      o.emails && typeof o.emails === 'object' && !Array.isArray(o.emails)
        ? { ...defaultEmails(), ...(o.emails as Partial<OnbEmails>) }
        : defaultEmails(),
    reminders: {
      enabled: rem.enabled ?? true,
      include_deferred: rem.include_deferred ?? true,
      frequency: rem.frequency ?? 'daily',
      send_to: Array.isArray(rem.send_to) ? rem.send_to : [],
    },
  };
};

export interface PortalSettingsRow {
  /** Raw editable-field keys the contractor may self-edit. */
  editableFields: string[];
  /** Raw onboarding_config jsonb (use parseOnboardingConfig for a typed view). */
  onboardingConfigRaw: unknown;
}

export const getPortalSettings = async (db: Db): Promise<PortalSettingsRow> => {
  const { data, error } = await db
    .from('portal_settings')
    .select('editable_fields, onboarding_config')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`portal_settings: ${error.message}`);
  return {
    editableFields: Array.isArray(data?.editable_fields) ? (data.editable_fields as string[]) : [],
    onboardingConfigRaw: data?.onboarding_config ?? {},
  };
};
