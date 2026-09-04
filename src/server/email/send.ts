import 'server-only';

/**
 * The one email-send wrapper every action uses (moved out of portal-admin.ts
 * once contracts.ts needed it too). A 'use server' module cannot export it —
 * every export there becomes a client-callable action, and this one would let
 * anyone send arbitrary mail from the app's Gmail.
 */

import { logEvent } from '@/server/audit';
import { sendEmail } from '@/server/email/transport';
import { env } from '@/server/env';

/**
 * Build the portal URL for template merge vars. The app is single-domain with
 * path-based routing (admin at `/`, contractor portal at `/portal`), so the
 * link must carry the `/portal` path — a bare-origin link would route a
 * logged-out contractor to the ADMIN login. APP_URL stays a clean origin.
 */
export const portalUrl = (): string =>
  `${(env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/portal`;

/**
 * Best-effort email send. Never throws; logs 'email_failed' on failure.
 * Returns whether the email actually went out so callers can tell the admin —
 * a silent no-op (unset SMTP creds) looks identical to success otherwise.
 */
export const trySend = async (
  to: string,
  subject: string,
  html: string,
  context: string,
): Promise<boolean> => {
  const result = await sendEmail({ to, subject, html });
  if (!result.ok) {
    await logEvent({
      action: 'email_failed',
      entity: to,
      detail: { context, error: result.error ?? 'unknown' },
    }).catch(() => {});
  }
  return result.ok;
};
