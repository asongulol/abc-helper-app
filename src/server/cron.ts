import 'server-only';
import { cronSecretOk } from '@/lib/cron/secret';
import { env } from '@/server/env';

/**
 * Validate a cron-invoked request's shared secret (`x-cron-secret` header),
 * mirroring the edge functions' gate (app_secrets.cron_secret ⇔ env.CRON_SECRET).
 * Cron ticks have no end user, so no Supabase JWT applies; the secret is the gate.
 * Fail-closed when CRON_SECRET is unset.
 */
export const isValidCronRequest = (req: Request): boolean =>
  cronSecretOk(req.headers.get('x-cron-secret'), env.CRON_SECRET);
