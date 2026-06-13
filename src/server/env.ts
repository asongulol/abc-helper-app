import 'server-only';
import { z } from 'zod';

/**
 * Typed, fail-fast environment loader (server-only). Pattern: NPM-Helper-App.
 * Integration secrets (Wise, Hubstaff) are optional at boot — their adapters
 * validate lazily so the app runs before every third-party credential exists.
 */

const EnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().startsWith('https://', 'must be an https Supabase URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  /** Admin SSO is restricted to this Google Workspace domain. */
  ADMIN_SSO_ALLOWED_DOMAIN: z.string().min(1).default('abckidsny.com'),
  /** Wise API (DRAFT-ONLY money staging — funding is forbidden, see guardrails). */
  WISE_API_TOKEN: z.string().optional(),
  WISE_PROFILE_ID: z.string().optional(),
  /** Hubstaff (time ingestion). */
  HUBSTAFF_REFRESH_TOKEN: z.string().optional(),
  /** Shared secret for cron-invoked routes (mirrors legacy x-cron-secret). */
  CRON_SECRET: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
