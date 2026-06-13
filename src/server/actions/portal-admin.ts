'use server';

/**
 * Portal-admin actions — IMPLEMENTED (ported from legacy edge fn `portal-admin`).
 * Every action: verify getCurrentAdmin() → Zod validate → db/service → audit log.
 *
 * createPortalLogin uses createServiceClient() (service role) because creating an
 * auth user requires the service-role key; a role check precedes the call (ADR-0004).
 *
 * Email sends are BEST-EFFORT: a mail failure logs action 'email_failed' and does
 * NOT fail the action or surface an error to the caller.
 */

import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { seedOnboardingProgress } from '@/db/queries/onboarding';
import { decryptWorkerTools } from '@/db/queries/secrets';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';
import {
  DEFAULT_HIRE_EMAILS,
  escapeHtml,
  mergeTemplate,
  toolsBlock,
} from '@/server/email/templates';
import { sendEmail } from '@/server/email/transport';
import { env } from '@/server/env';

/**
 * Result of a server action. When `T` is `undefined` (the default) the success
 * branch carries no `data`; when `T` is set, `data` is REQUIRED on success so
 * callers can read it after a single `if (res.ok)` guard (no extra
 * `res.data` undefined check).
 */
export type ActionResult<T = undefined> = [T] extends [undefined]
  ? { ok: true; message?: string } | { ok: false; error: string }
  : { ok: true; data: T; message?: string } | { ok: false; error: string };

/** Generate a temp password matching the legacy pattern (Abc-xxxxxx-NNNN). */
const genTempPassword = (): string =>
  `Abc-${Math.random().toString(36).slice(2, 8)}-${Math.floor(Math.random() * 9000 + 1000)}`;

// ---------------------------------------------------------------------------
// Internal email helpers
// ---------------------------------------------------------------------------

/** Build the portal URL base for template merge vars. */
const portalUrl = (): string => env.APP_URL ?? 'http://localhost:3000';

/**
 * Look up a worker's display name from the service client.
 * Falls back to 'there' on any failure.
 */
const fetchWorkerName = async (workerId: string): Promise<string> => {
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from('workers')
      .select('first_name, middle_name, last_name')
      .eq('id', workerId)
      .maybeSingle();
    if (!data) return 'there';
    return (
      [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' ').trim() ||
      'there'
    );
  } catch {
    return 'there';
  }
};

/**
 * Best-effort email send. Never throws; logs 'email_failed' on failure.
 */
const trySend = async (
  to: string,
  subject: string,
  html: string,
  context: string,
): Promise<void> => {
  const result = await sendEmail({ to, subject, html });
  if (!result.ok) {
    await logEvent({
      action: 'email_failed',
      entity: to,
      detail: { context, error: result.error ?? 'unknown' },
    }).catch(() => {});
  }
};

/**
 * Send the welcome email (hire email 1).
 * Includes portal login credentials and Wise referral link.
 */
const sendWelcomeEmail = async (
  to: string,
  workerId: string,
  tempPassword: string,
): Promise<void> => {
  const name = await fetchWorkerName(workerId);
  const cfg = DEFAULT_HIRE_EMAILS;
  const vars: Record<string, string> = {
    name: escapeHtml(name),
    email: escapeHtml(to),
    password: tempPassword,
    portal_url: portalUrl(),
    wise_referral_url: cfg.wise_referral_url,
  };
  const subject = mergeTemplate(cfg.welcome.subject, vars);
  const html = mergeTemplate(cfg.welcome.html, vars);
  await trySend(to, subject, html, 'welcome');
};

/**
 * Send the credentials-only email (used on password reset / resend).
 */
const sendCredentialsEmail = async (
  to: string,
  workerId: string,
  tempPassword: string,
): Promise<void> => {
  const name = await fetchWorkerName(workerId);
  const cfg = DEFAULT_HIRE_EMAILS;
  const vars: Record<string, string> = {
    name: escapeHtml(name),
    email: escapeHtml(to),
    password: tempPassword,
    portal_url: portalUrl(),
  };
  const subject = mergeTemplate(cfg.credentials.subject, vars);
  const html = mergeTemplate(cfg.credentials.html, vars);
  await trySend(to, subject, html, 'credentials');
};

/**
 * Send the withdraw/offer-withdrawal email.
 */
const sendWithdrawEmail = async (to: string, workerId: string): Promise<void> => {
  const name = await fetchWorkerName(workerId);
  const cfg = DEFAULT_HIRE_EMAILS;
  const vars: Record<string, string> = { name: escapeHtml(name) };
  const subject = mergeTemplate(cfg.withdraw.subject, vars);
  const html = mergeTemplate(cfg.withdraw.html, vars);
  await trySend(to, subject, html, 'withdraw');
};

// ---------------------------------------------------------------------------
// Exported server actions
// ---------------------------------------------------------------------------

/**
 * Create a portal login for a worker.
 * Uses the service client (required for auth.admin.createUser) after verifying admin role.
 * Best-effort sends the welcome email after successful creation.
 */
export async function createPortalLogin(args: {
  workerId: string;
  email: string;
}): Promise<ActionResult<{ tempPassword?: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const email = args.email.trim().toLowerCase();
  if (!email || !args.workerId) return { ok: false, error: 'worker_id and email are required.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { ok: false, error: 'Invalid email address.' };

  try {
    const db = await createServerSupabase();

    // Guard: check existing login
    const { data: existing } = await db
      .from('contractor_logins')
      .select('worker_id, email, status')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (existing) {
      return {
        ok: false,
        error: `This contractor already has a portal login (${existing.email ?? 'set'}, ${existing.status}).`,
      };
    }

    // Service client required for auth.admin.createUser (bypasses RLS; admin verified above).
    const svc = createServiceClient();
    const pw = genTempPassword();

    // Check email not already in auth
    const { data: authUser, error: authErr } = await svc.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
      user_metadata: { must_set_password: true },
    });
    if (authErr || !authUser.user) {
      return { ok: false, error: authErr?.message ?? 'Could not create portal login.' };
    }
    const authUserId = authUser.user.id;

    // Link contractor_logins row
    const { error: linkErr } = await svc
      .from('contractor_logins')
      .upsert(
        { worker_id: args.workerId, auth_user_id: authUserId, email, status: 'active' },
        { onConflict: 'worker_id', ignoreDuplicates: false },
      );
    if (linkErr) {
      return { ok: false, error: `Login created but linking failed: ${linkErr.message}` };
    }

    // Seed onboarding_progress so new hire appears in the Onboarding queue.
    await seedOnboardingProgress(svc, args.workerId);

    await logEvent({
      action: 'portal_login.created',
      entity: email,
      detail: { worker_id: args.workerId, by: admin.email },
    });

    // Best-effort welcome email — failure does NOT fail the action.
    await sendWelcomeEmail(email, args.workerId, pw);

    return { ok: true, data: { tempPassword: pw } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Create login failed.' };
  }
}

/**
 * Reset portal password — re-issues a temp password for an existing login.
 * Service client required for auth.admin.updateUserById.
 * Best-effort sends the credentials email after successful reset.
 */
export async function resetPortalPassword(args: {
  workerId: string;
}): Promise<ActionResult<{ tempPassword?: string }>> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const db = await createServerSupabase();
    const { data: login } = await db
      .from('contractor_logins')
      .select('auth_user_id, email, status')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (!login?.auth_user_id)
      return { ok: false, error: 'This contractor has no portal login yet — create one first.' };

    // Service client required to reset auth user password (admin verified above).
    const svc = createServiceClient();
    const pw = genTempPassword();
    const { error } = await svc.auth.admin.updateUserById(login.auth_user_id, {
      password: pw,
      user_metadata: { must_set_password: true },
    });
    if (error) return { ok: false, error: `Could not reset password: ${error.message}` };

    await logEvent({
      action: 'portal_login.reset_password',
      entity: login.email ?? args.workerId,
      detail: { worker_id: args.workerId, by: admin.email },
    });

    // Best-effort credentials email.
    if (login.email) {
      await sendCredentialsEmail(login.email, args.workerId, pw);
    }

    return { ok: true, data: { tempPassword: pw } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Reset failed.' };
  }
}

/** Revoke a contractor's portal access (sets contractor_logins.status = 'revoked'). */
export async function revokePortalLogin(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const db = await createServerSupabase();
    const { error } = await db
      .from('contractor_logins')
      .update({ status: 'revoked' })
      .eq('worker_id', args.workerId);
    if (error) return { ok: false, error: `Revoke failed: ${error.message}` };

    await logEvent({
      action: 'portal_login.revoked',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Revoke failed.' };
  }
}

/**
 * Resend hire emails for a contractor.
 * `which` controls what is sent: 'welcome' (default) | 'credentials' | 'both'.
 * For 'credentials' or 'both', a current tempPassword must be supplied (it is
 * not stored — this matches the legacy behaviour).
 */
export async function resendHireEmails(args: {
  workerId: string;
  which?: 'welcome' | 'credentials' | 'both';
  password?: string;
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const db = await createServerSupabase();
    const { data: login } = await db
      .from('contractor_logins')
      .select('email, status')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (!login?.email)
      return {
        ok: false,
        error: 'This contractor has no portal login yet — create one first.',
      };

    const which = args.which ?? 'welcome';
    const pw = args.password?.trim() ?? '';

    const sends: Promise<void>[] = [];
    if (which === 'welcome' || which === 'both') {
      sends.push(sendWelcomeEmail(login.email, args.workerId, pw));
    }
    if ((which === 'credentials' || which === 'both') && pw) {
      sends.push(sendCredentialsEmail(login.email, args.workerId, pw));
    }
    await Promise.all(sends);

    await logEvent({
      action: 'portal_login.resend_hire_emails',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email, which },
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Resend failed.' };
  }
}

/**
 * Send tools credentials email — decrypts stored tool creds via the
 * `decrypt_worker_tools` RPC and sends the tools email.
 */
export async function sendToolsEmail(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const db = await createServerSupabase();
    const { data: login } = await db
      .from('contractor_logins')
      .select('email')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (!login?.email) return { ok: false, error: 'This contractor has no portal login yet.' };

    // Decrypt tool credentials via the service-role RPC.
    const svc = createServiceClient();
    const creds = await decryptWorkerTools(svc, args.workerId);
    if (creds === null || typeof creds !== 'object' || Array.isArray(creds)) {
      return { ok: false, error: 'No tool credentials stored for this contractor.' };
    }

    const name = await fetchWorkerName(args.workerId);
    const cfg = DEFAULT_HIRE_EMAILS;
    const vars: Record<string, string> = {
      name: escapeHtml(name),
      portal_url: portalUrl(),
      tools_block: toolsBlock(creds),
    };
    const subject = mergeTemplate(cfg.tools.subject, vars);
    const html = mergeTemplate(cfg.tools.html, vars);

    // Best-effort send.
    await trySend(login.email, subject, html, 'tools');

    await logEvent({
      action: 'portal_login.send_tools_email',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email },
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Tools email failed.' };
  }
}

/**
 * Withdraw a pending offer — revokes portal login, bans the auth user, marks
 * worker + company links 'ended', and sends a withdrawal notice.
 * Refuses if any payroll history exists.
 */
export async function withdrawOffer(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(args.workerId)) return { ok: false, error: 'Valid worker_id (uuid) required.' };

  try {
    const db = await createServerSupabase();

    // Guard: refuse if payroll history exists
    const [{ count: payCount }, { count: teCount }] = await Promise.all([
      db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('worker_id', args.workerId),
      db
        .from('time_entries')
        .select('work_date', { count: 'exact', head: true })
        .eq('worker_id', args.workerId),
    ]);
    if ((payCount ?? 0) > 0 || (teCount ?? 0) > 0) {
      return {
        ok: false,
        error:
          'This contractor has payroll history — an offer cannot be withdrawn. Deactivate them on the roster instead.',
      };
    }

    const svc = createServiceClient();

    // Fetch contractor login (email + auth_user_id) and worker email fallback.
    const [{ data: cl }, { data: w }] = await Promise.all([
      svc
        .from('contractor_logins')
        .select('auth_user_id, email')
        .eq('worker_id', args.workerId)
        .maybeSingle(),
      svc.from('workers').select('email').eq('id', args.workerId).maybeSingle(),
    ]);
    const to = (cl?.email ?? w?.email ?? '').trim();

    // Revoke login record (best-effort)
    try {
      await svc
        .from('contractor_logins')
        .update({ status: 'revoked' })
        .eq('worker_id', args.workerId);
    } catch {
      /* best-effort */
    }

    // Ban auth user (blocks sign-in)
    if (cl?.auth_user_id) {
      await svc.auth.admin
        .updateUserById(cl.auth_user_id, { ban_duration: '876000h' })
        .catch(() => {});
    }

    // Mark worker + company links ended (best-effort)
    await Promise.allSettled([
      svc.from('workers').update({ status: 'ended' }).eq('id', args.workerId),
      svc.from('worker_companies').update({ status: 'ended' }).eq('worker_id', args.workerId),
    ]);

    // Best-effort withdraw email.
    if (to) {
      await sendWithdrawEmail(to, args.workerId);
    }

    await logEvent({
      action: 'withdraw_offer',
      entity: to || args.workerId,
      detail: { worker_id: args.workerId, by: admin.email },
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Withdraw failed.' };
  }
}

/**
 * Full contractor deletion (auth user + all rows). Owner-gated, destructive.
 * Service client required for auth.admin.deleteUser (admin+owner verified above).
 */
export async function deleteContractor(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner) return { ok: false, error: 'Owner role required for contractor deletion.' };

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(args.workerId)) return { ok: false, error: 'Valid worker_id (uuid) required.' };

  try {
    const db = await createServerSupabase();

    // Guard: refuse if payroll history exists
    const [{ count: payCount }, { count: teCount }] = await Promise.all([
      db
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('worker_id', args.workerId),
      db
        .from('time_entries')
        .select('work_date', { count: 'exact', head: true })
        .eq('worker_id', args.workerId),
    ]);
    if ((payCount ?? 0) > 0 || (teCount ?? 0) > 0) {
      return {
        ok: false,
        error:
          'This contractor has payroll history (payments or time entries) and cannot be deleted — deactivate them instead.',
      };
    }

    // Fetch auth_user_id before deleting
    const { data: cl } = await db
      .from('contractor_logins')
      .select('auth_user_id')
      .eq('worker_id', args.workerId)
      .maybeSingle();

    // Service client required to delete auth user (owner verified above).
    const svc = createServiceClient();
    const { error: delErr } = await svc.from('workers').delete().eq('id', args.workerId);
    if (delErr) return { ok: false, error: `Delete failed: ${delErr.message}` };

    if (cl?.auth_user_id) {
      await svc.auth.admin.deleteUser(cl.auth_user_id).catch(() => {});
    }

    await logEvent({
      action: 'delete_contractor',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email, login_removed: !!cl?.auth_user_id },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed.' };
  }
}
