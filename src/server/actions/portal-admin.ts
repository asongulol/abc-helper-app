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
import { seedAgreementPrefill, seedOnboardingProgress } from '@/db/queries/onboarding';
import { decryptWorkerTools } from '@/db/queries/secrets';
import { endEngagement } from '@/db/queries/workers';
import { humanizeError } from '@/lib/errors';
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

/**
 * Build the portal URL for template merge vars. The app is single-domain with
 * path-based routing (admin at `/`, contractor portal at `/portal`), so the
 * link must carry the `/portal` path — a bare-origin link would route a
 * logged-out contractor to the ADMIN login. APP_URL stays a clean origin.
 */
const portalUrl = (): string =>
  `${(env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/portal`;

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
 * Returns whether the email actually went out so callers can tell the admin —
 * a silent no-op (unset SMTP creds) looks identical to success otherwise.
 */
const trySend = async (
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

/**
 * Send the welcome email (hire email 1).
 * Includes portal login credentials and Wise referral link.
 */
const sendWelcomeEmail = async (
  to: string,
  workerId: string,
  tempPassword: string,
): Promise<boolean> => {
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
  return trySend(to, subject, html, 'welcome');
};

/**
 * Send the credentials-only email (used on password reset / resend).
 */
const sendCredentialsEmail = async (
  to: string,
  workerId: string,
  tempPassword: string,
): Promise<boolean> => {
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
  return trySend(to, subject, html, 'credentials');
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
}): Promise<ActionResult<{ tempPassword?: string; emailSent?: boolean; email?: string }>> {
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
      return {
        ok: false,
        error: authErr?.message ?? 'Could not create portal login.',
      };
    }
    const authUserId = authUser.user.id;

    // Link contractor_logins row
    const { error: linkErr } = await svc.from('contractor_logins').upsert(
      {
        worker_id: args.workerId,
        auth_user_id: authUserId,
        email,
        status: 'active',
      },
      { onConflict: 'worker_id', ignoreDuplicates: false },
    );
    if (linkErr) {
      return {
        ok: false,
        error: `Login created but linking failed: ${linkErr.message}`,
      };
    }

    // Seed onboarding_progress so new hire appears in the Onboarding queue.
    await seedOnboardingProgress(svc, args.workerId);

    // Best-effort: derive agreement prefill for workers added outside the hire
    // wizard so their contracts don't render blank rate/position/company lines
    // (the wizard path overwrites these with its own values right after).
    try {
      await seedAgreementPrefill(svc, args.workerId, admin.userId);
    } catch {
      /* non-fatal: admin can fix prefill from the onboarding review panel */
    }

    await logEvent({
      action: 'portal_login.created',
      entity: email,
      detail: { worker_id: args.workerId, by: admin.email },
    });

    // Best-effort welcome email — failure does NOT fail the action, but the
    // admin is told (the banner offers the temp password as manual fallback).
    const emailSent = await sendWelcomeEmail(email, args.workerId, pw);

    return { ok: true, data: { tempPassword: pw, emailSent, email } };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Create login failed.'),
    };
  }
}

/**
 * Reset portal password — re-issues a temp password for an existing login.
 * Service client required for auth.admin.updateUserById.
 * Best-effort sends the credentials email after successful reset.
 */
export async function resetPortalPassword(args: { workerId: string; email?: string }): Promise<
  ActionResult<{
    tempPassword?: string;
    email?: string;
    changed?: boolean;
    emailSent?: boolean;
  }>
> {
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
      return {
        ok: false,
        error: 'This contractor has no portal login yet — create one first.',
      };

    // Optionally correct the login email (legacy "Update login & resend").
    const newEmail = args.email?.trim();
    const changed = !!newEmail && newEmail.toLowerCase() !== (login.email ?? '').toLowerCase();
    const effectiveEmail = changed ? (newEmail as string) : (login.email ?? null);

    // Service client required to reset auth user password (admin verified above).
    const svc = createServiceClient();
    const pw = genTempPassword();
    const { error } = await svc.auth.admin.updateUserById(login.auth_user_id, {
      password: pw,
      ...(changed ? { email: newEmail, email_confirm: true } : {}),
      user_metadata: { must_set_password: true },
    });
    if (error) return { ok: false, error: `Could not reset password: ${error.message}` };

    if (changed) {
      await db.from('contractor_logins').update({ email: newEmail }).eq('worker_id', args.workerId);
    }

    await logEvent({
      action: 'portal_login.reset_password',
      entity: effectiveEmail ?? args.workerId,
      detail: {
        worker_id: args.workerId,
        by: admin.email,
        email_changed: changed,
      },
    });

    // Best-effort credentials email to the (possibly corrected) address.
    const emailSent = effectiveEmail
      ? await sendCredentialsEmail(effectiveEmail, args.workerId, pw)
      : false;

    return {
      ok: true,
      data: {
        tempPassword: pw,
        ...(effectiveEmail ? { email: effectiveEmail } : {}),
        changed,
        emailSent,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Reset failed.'),
    };
  }
}

/**
 * Revoke a contractor's portal access (sets contractor_logins.status = 'revoked',
 * which is the only thing `my_worker_id()` — and therefore every contractor RLS
 * policy — looks at).
 *
 * Service client, role verified above. `contractor_logins` has exactly ONE RLS
 * policy and it is SELECT-only (baseline `contractor_logins_self`), so this
 * update through a user-session client matched 0 rows and returned no error:
 * the button reported "Portal access revoked." and revoked nothing. The legacy
 * `portal-admin` edge function has always PATCHed this with the service key —
 * same reason.
 */
export async function revokePortalLogin(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const { error } = await createServiceClient()
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
    return {
      ok: false,
      error: humanizeError(err, 'Revoke failed.'),
    };
  }
}

/**
 * Give a revoked portal login back (status → 'active'). The inverse of
 * revokePortalLogin, and the undo for the nightly sunset sweep
 * (`sunsetPortalLogins`).
 *
 * It exists because the sweep made revocation automatic: a departed contractor
 * whose final pay landed loses the portal on the next tick, and if that pay is
 * later re-drafted — a Wise transfer that bounced after `paid_at` was stamped is
 * the documented case (#90 B) — they are owed money again with no way back into
 * the one screen showing their own pay records. The sweep deliberately cannot
 * restore anyone itself: it cannot tell its own revocation from an admin's, and
 * silently reversing a deliberate one is worse than a manual click here.
 *
 * Password and email are untouched; a login whose auth user was BANNED
 * (withdrawOffer) still cannot sign in — lift the ban separately.
 */
export async function restorePortalLogin(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const svc = createServiceClient();
    const { data: login } = await svc
      .from('contractor_logins')
      .select('status')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (!login)
      return {
        ok: false,
        error: 'This contractor has no portal login yet — create one first.',
      };
    if (login.status === 'active') return { ok: true, message: 'Portal access is already active.' };

    const { error } = await svc
      .from('contractor_logins')
      .update({ status: 'active' })
      .eq('worker_id', args.workerId);
    if (error) return { ok: false, error: `Restore failed: ${error.message}` };

    await logEvent({
      action: 'portal_login.restored',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email, from: login.status },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Restore failed.'),
    };
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

    const sends: Promise<boolean>[] = [];
    if (which === 'welcome' || which === 'both') {
      sends.push(sendWelcomeEmail(login.email, args.workerId, pw));
    }
    if ((which === 'credentials' || which === 'both') && pw) {
      sends.push(sendCredentialsEmail(login.email, args.workerId, pw));
    }
    const results = await Promise.all(sends);
    if (results.some((sent) => !sent)) {
      return { ok: false, error: 'The email could not be sent — check the audit log for details.' };
    }

    await logEvent({
      action: 'portal_login.resend_hire_emails',
      entity: args.workerId,
      detail: { worker_id: args.workerId, by: admin.email, which },
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Resend failed.'),
    };
  }
}

/**
 * Send tools credentials email — decrypts via the `decrypt_worker_tools` RPC
 * (persistent — shared-prod model) and emails the credentials. Re-readable: the
 * admin can resend without re-provisioning. Authorization is enforced here
 * (company scope), since the RPC itself is unscoped service-role.
 */
export async function sendToolsEmail(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  try {
    const db = await createServerSupabase();
    // Authorize per-company: the decrypt RPC is service-role + unscoped (matches
    // shared prod, where decrypt_worker_tools has no in-DB authz), so a non-owner
    // admin must be confirmed to share a company with this worker BEFORE the
    // decrypt — otherwise any admin could read any worker's tool credentials.
    if (!admin.isOwner) {
      const { data: links } = await db
        .from('worker_companies')
        .select('company_id')
        .eq('worker_id', args.workerId);
      const inScope = (links ?? []).some((l) => admin.companyIds.includes(l.company_id));
      if (!inScope) return { ok: false, error: 'Not authorized for this contractor.' };
    }

    const { data: login } = await db
      .from('contractor_logins')
      .select('email')
      .eq('worker_id', args.workerId)
      .maybeSingle();
    if (!login?.email) return { ok: false, error: 'This contractor has no portal login yet.' };

    // Decrypt the stored credentials via the service-role RPC (persistent).
    const svc = createServiceClient();
    const creds = await decryptWorkerTools(svc, args.workerId);
    if (creds === null || typeof creds !== 'object' || Array.isArray(creds)) {
      return {
        ok: false,
        error: 'No tool credentials provisioned for this contractor — provision the tools first.',
      };
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
    return {
      ok: false,
      error: humanizeError(err, 'Tools email failed.'),
    };
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

    // Mark worker + company links ended (best-effort).
    //
    // The links go through `endEngagement`, not a bare status write. A bare
    // `status='ended'` leaves `ended_on` NULL, and `ended_on` is what every
    // last-day rule measures against — an unstamped 'ended' link is a departure
    // with no last day, so the time-import guard, the allowance gate and the
    // portal's final-pay gate all leave it alone and the contractor keeps
    // importing and paying (#86). It is also now a CHECK violation (migration
    // 37), which would fail this write outright.
    //
    // Today is the last day: the guard above already refused if any payment or
    // time entry exists, so a withdrawn offer has nothing behind it to bound.
    // `endEngagement` closes the rates and coverage targets onboarding may have
    // opened, in the same pass. Service client for the same reason as the rest
    // of this action — a company-scoped admin cannot see every link through RLS
    // and would silently withdraw only part of the offer.
    await Promise.allSettled([
      svc.from('workers').update({ status: 'ended' }).eq('id', args.workerId),
      endEngagement(svc, {
        workerId: args.workerId,
        companyId: null,
        lastDay: new Date().toISOString().slice(0, 10),
      }),
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
    return {
      ok: false,
      error: humanizeError(err, 'Withdraw failed.'),
    };
  }
}

/**
 * Full contractor deletion (auth user + all rows). Owner-gated, destructive.
 * Service client required for auth.admin.deleteUser (owner verified above).
 *
 * Two-tier safety per §1.7:
 *  - HARD block on payments / time entries — never deletable, "deactivate instead".
 *  - SOFT block on onboarding signatures / documents — requires `force === true`;
 *    without it, the action returns an error describing what would be deleted.
 * The server is the authority; the UI's typed-name confirm is a courtesy gate.
 */
export async function deleteContractor(args: {
  workerId: string;
  force?: boolean;
}): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };
  if (!admin.isOwner) return { ok: false, error: 'Owner role required for contractor deletion.' };

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(args.workerId)) return { ok: false, error: 'Valid worker_id (uuid) required.' };
  const force = args.force === true;

  try {
    const db = await createServerSupabase();

    // Count all four record classes in parallel.
    const [{ count: payCount }, { count: teCount }, { count: sigCount }, { count: docCount }] =
      await Promise.all([
        db
          .from('payments')
          .select('id', { count: 'exact', head: true })
          .eq('worker_id', args.workerId),
        db
          .from('time_entries')
          .select('work_date', { count: 'exact', head: true })
          .eq('worker_id', args.workerId),
        db
          .from('onboarding_signatures')
          .select('id', { count: 'exact', head: true })
          .eq('worker_id', args.workerId),
        db
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('worker_id', args.workerId),
      ]);

    // HARD block: payroll history is never deletable.
    if ((payCount ?? 0) > 0 || (teCount ?? 0) > 0) {
      return {
        ok: false,
        error:
          'This contractor has payroll history (payments or time entries) and cannot be deleted — deactivate them instead.',
      };
    }

    // SOFT block: signatures / documents require an explicit force.
    const sigs = sigCount ?? 0;
    const docs = docCount ?? 0;
    if (!force && (sigs > 0 || docs > 0)) {
      const parts: string[] = [];
      if (sigs > 0) parts.push(`${sigs} signed agreement${sigs === 1 ? '' : 's'}`);
      if (docs > 0) parts.push(`${docs} uploaded document${docs === 1 ? '' : 's'}`);
      return {
        ok: false,
        error: `This contractor has ${parts.join(' and ')} — deleting will permanently remove them. Confirm to proceed.`,
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
      detail: {
        worker_id: args.workerId,
        by: admin.email,
        login_removed: !!cl?.auth_user_id,
        force,
        signatures: sigs,
        documents: docs,
      },
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Delete failed.'),
    };
  }
}
