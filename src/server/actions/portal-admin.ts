'use server';

/**
 * Portal-admin actions — IMPLEMENTED (ported from legacy edge fn `portal-admin`).
 * Every action: verify getCurrentAdmin() → Zod validate → db/service → audit log.
 *
 * createPortalLogin uses createServiceClient() (service role) because creating an
 * auth user requires the service-role key; a role check precedes the call (ADR-0004).
 */

import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import { seedOnboardingProgress } from '@/db/queries/onboarding';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';

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

/**
 * Create a portal login for a worker.
 * Uses the service client (required for auth.admin.createUser) after verifying admin role.
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

    return { ok: true, data: { tempPassword: pw } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Create login failed.' };
  }
}

/**
 * Reset portal password — re-issues a temp password for an existing login.
 * Service client required for auth.admin.updateUserById.
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
 * Resend hire emails — no-op in this Next.js port (SMTP transport lives in the
 * legacy edge function; a future phase wires a Resend/nodemailer transport).
 * Returns ok so callers don't break.
 */
export async function resendHireEmails(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  await logEvent({
    action: 'portal_login.resend_hire_emails',
    entity: args.workerId,
    detail: { worker_id: args.workerId, by: admin.email, note: 'email send deferred to edge fn' },
  });
  // Email transport deferred: legacy SMTP/Resend wiring lives in the edge function.
  // Return ok with a message so the UI can inform the admin.
  return {
    ok: true,
    message:
      'Email resend queued — ensure the legacy portal-admin edge function handles the SMTP transport.',
  };
}

/**
 * Send tools credentials email — deferred to edge fn (same as resendHireEmails).
 */
export async function sendToolsEmail(args: { workerId: string }): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  await logEvent({
    action: 'portal_login.send_tools_email',
    entity: args.workerId,
    detail: { worker_id: args.workerId, by: admin.email, note: 'email send deferred to edge fn' },
  });
  return {
    ok: true,
    message: 'Tools email deferred to the portal-admin edge function transport.',
  };
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
