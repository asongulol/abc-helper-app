import 'server-only';
import { z } from 'zod';

/**
 * Typed, fail-fast environment loader (server-only). Pattern: NPM-Helper-App.
 * Integration secrets (Wise, Hubstaff) are optional at boot — their adapters
 * validate lazily so the app runs before every third-party credential exists.
 */

const EnvSchema = z.object({
  // https in hosted envs; http allowed for the local `supabase start` stack.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().startsWith('http', 'must be a Supabase URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  /**
   * Admin SSO is restricted to these Google Workspace domain(s). Comma-separated
   * for multiple (e.g. "abckidsny.com,abbilabs.com"). Enforced on the OAuth
   * callback (src/app/auth/callback/route.ts) and on admin creation
   * (src/server/actions/admin-manage.ts) via src/server/auth/allowed-domains.ts.
   */
  ADMIN_SSO_ALLOWED_DOMAIN: z.string().min(1).default('abckidsny.com,abbilabs.com'),
  /** Wise API (DRAFT-ONLY money staging — funding is forbidden, see guardrails). */
  WISE_API_TOKEN: z.string().optional(),
  WISE_PROFILE_ID: z.string().optional(),
  /** Hubstaff (time ingestion). */
  HUBSTAFF_REFRESH_TOKEN: z.string().optional(),
  /**
   * Optional override for the Hubstaff API base URL (e.g. for mocking in tests).
   * Defaults to https://api.hubstaff.com/v2 in client.ts.
   */
  HUBSTAFF_API_BASE: z.string().url().optional(),
  /** Shared secret for cron-invoked routes (mirrors legacy x-cron-secret). */
  CRON_SECRET: z.string().optional(),
  /**
   * Optional override pinning the employer company id. Otherwise derived from
   * companies.kind='employer' (Aaron Anderson E.H.S. LLC). Mirrors the
   * hubstaff-sync edge function's EMPLOYER_COMPANY_ID escape hatch.
   */
  EMPLOYER_COMPANY_ID: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Gmail SMTP credentials for new-hire transactional email (smtp.gmail.com:465).
   * Set at deploy time: GMAIL_USER = the sending Gmail/Workspace address,
   * GMAIL_APP_PASSWORD = a Google app-password (not the account password),
   * HIRING_REVIEW_EMAIL_FROM = optional "Name <addr>" override for the From header.
   * Without GMAIL_USER + GMAIL_APP_PASSWORD every send no-ops and logs a warning.
   */
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  HIRING_REVIEW_EMAIL_FROM: z.string().optional(),
  /**
   * Base origin for portal links embedded in hire emails (e.g. https://3a.abbilabs.com).
   * The `/portal` path is appended by portalUrl() in portal-admin.ts — set this to the
   * bare origin, not a path.
   * Defaults to http://localhost:3000 for local dev.
   */
  APP_URL: z.string().url().optional().default('http://localhost:3000'),
  /**
   * PHI column encryption (app-layer envelope encryption — see
   * src/server/crypto). PHI_KMS_PROVIDER selects the key source: 'local' (a
   * base64 32-byte master key in PHI_LOCAL_MASTER_KEY, dev only) or 'aws' (AWS
   * KMS key PHI_KMS_KEY_ID — adapter to be wired). Defaults to 'local'.
   */
  PHI_KMS_PROVIDER: z.enum(['local', 'aws']).optional(),
  PHI_LOCAL_MASTER_KEY: z.string().optional(),
  PHI_KMS_KEY_ID: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env: Env = parsed.data;
