import 'server-only';

/**
 * Provider-agnostic email transport.
 *
 * Backed by Gmail SMTP (smtp.gmail.com:465, app-password auth).
 * A future provider swap only touches this file — callers depend only on
 * `sendEmail({ to, subject, html })`.
 *
 * RULES:
 *  - NEVER throws. All errors are captured and returned as { ok:false }.
 *  - Fresh nodemailer transporter per send (matches legacy denomailer pattern).
 *  - If GMAIL_USER / GMAIL_APP_PASSWORD are unset, logs once and no-ops.
 */

import nodemailer from 'nodemailer';
import { env } from '@/server/env';

// ---------------------------------------------------------------------------
// Internal logger (no console.log per Biome rules)
// ---------------------------------------------------------------------------

const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void => {
  const line =
    meta !== undefined
      ? `[email:${level}] ${msg} ${JSON.stringify(meta)}`
      : `[email:${level}] ${msg}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a single transactional email via Gmail SMTP.
 * Returns `{ ok: false, error: 'email not configured' }` when credentials
 * are absent — callers must not throw on this result.
 */
export const sendEmail = async ({ to, subject, html }: SendEmailArgs): Promise<SendEmailResult> => {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    log('warn', 'Gmail SMTP credentials not set — email skipped', {
      to,
      subject,
    });
    return { ok: false, error: 'email not configured' };
  }

  const from = env.HIRING_REVIEW_EMAIL_FROM ?? `Aaron Anderson E.H.S. LLC <${user}>`;

  // Fresh transporter per message (matches legacy denomailer pattern: connection
  // is opened, message sent, then closed — no connection pooling).
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({ from, to, subject, html });
    log('info', 'Email sent', { to, subject });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'Email send failed', { to, subject, error });
    return { ok: false, error };
  } finally {
    transporter.close();
  }
};
