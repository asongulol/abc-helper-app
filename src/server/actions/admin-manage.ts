'use server';

/**
 * Admin management actions — CONTRACT FILE (legacy edge fn `admin-manage`).
 * Mirrors the legacy admin-manage Edge Function: ALLOWED_DOMAINS gate, RPC
 * lookup for the auth user, pending_admins fallback, last-owner guard.
 * All writes use the service client ONLY after the caller is verified as owner
 * (service role bypasses RLS; the owner check must be first — ADR-0004).
 */

import { createServerSupabase } from '@/db/clients/server';
import { createServiceClient } from '@/db/clients/service';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { requireOwner } from '@/server/auth/admin';
import { ALLOWED_ADMIN_DOMAINS, isAllowedAdminEmail } from '@/server/auth/allowed-domains';

// Admins must use a work-domain email (same gate the OAuth callback enforces —
// the allowed domains come from ADMIN_SSO_ALLOWED_DOMAIN, see allowed-domains.ts).

/**
 * Add an admin. Uses the admin_lookup_auth_user RPC (service client,
 * owner-gated). If the user hasn't signed in yet, inserts into pending_admins;
 * a DB trigger promotes them the moment they first sign in.
 * Signature kept identical to the contract file — companyIds used to populate
 * admin_companies scope after the insert.
 */
export async function addAdmin(args: {
  email: string;
  name?: string;
  role: string;
  companyIds: string[];
}): Promise<ActionResult> {
  // Verify caller is owner FIRST, then create service client (ADR-0004).
  const caller = await requireOwner().catch(() => null);
  if (!caller) return { ok: false, error: 'Not authorized — owner role required.' };

  const email = String(args.email ?? '')
    .trim()
    .toLowerCase();
  const role = args.role === 'owner' ? 'owner' : 'admin';

  if (!email) return { ok: false, error: 'Email required.' };
  if (!isAllowedAdminEmail(email))
    return {
      ok: false,
      error: `Email must be on an allowed work domain (${ALLOWED_ADMIN_DOMAINS.join(', ')}).`,
    };

  // Service client — RLS bypassed; caller ownership already verified above.
  const svc = createServiceClient();

  // Guard: don't turn a contractor portal login into an admin.
  const { data: cl } = await svc
    .from('contractor_logins')
    .select('worker_id')
    .eq('email', email)
    .limit(1);
  if (cl && cl.length > 0)
    return {
      ok: false,
      error: 'That email is a contractor portal login — use a different address for an admin.',
    };

  // Find the auth user via the service-role-only RPC (admin_lookup_auth_user).
  const { data: userId, error: rpcErr } = await svc.rpc('admin_lookup_auth_user', {
    p_email: email,
  });
  if (rpcErr) return { ok: false, error: `Lookup failed: ${rpcErr.message}` };

  const validUuid =
    userId &&
    typeof userId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

  if (!validUuid) {
    // Hasn't signed in yet — pre-add to pending_admins.
    const { error: pendErr } = await svc
      .from('pending_admins')
      .upsert({ email, role, added_by: caller.userId }, { onConflict: 'email' });
    if (pendErr) return { ok: false, error: `Couldn't pre-add: ${pendErr.message}` };
    await logEvent({
      action: 'admin.pre_added',
      entity: email,
      detail: { role, ...(args.name ? { name: args.name } : {}) },
    });
    return {
      ok: true,
      message: `${email} added to pending — they'll be promoted on first sign-in.`,
    };
  }

  // Already an admin?
  const { data: existing } = await svc
    .from('admin_users')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing)
    return {
      ok: false,
      error: `${email} is already an ${existing.role}. Use the role control to change it.`,
    };

  const insertPayload: {
    user_id: string;
    email: string;
    role: string;
    added_by: string;
    name?: string;
  } = { user_id: userId, email, role, added_by: caller.userId };
  if (args.name) insertPayload.name = args.name;

  const { error: insErr } = await svc.from('admin_users').insert(insertPayload);
  if (insErr) return { ok: false, error: `Couldn't add admin: ${insErr.message}` };

  // Grant company scope for non-owners.
  if (role !== 'owner' && args.companyIds.length > 0) {
    await svc.from('admin_companies').upsert(
      args.companyIds.map((cid) => ({
        admin_email: email,
        company_id: cid,
        added_by: caller.userId,
      })),
      { onConflict: 'admin_email,company_id' },
    );
  }

  await logEvent({
    action: 'admin.added',
    entity: email,
    detail: { user_id: userId, role },
  });
  return { ok: true, message: `${email} added as ${role}.` };
}

/**
 * Remove an admin or cancel a pending invite.
 * The DB trigger also blocks removing the last owner.
 * Signature kept identical to the contract file.
 */
export async function removeAdmin(args: { email: string }): Promise<ActionResult> {
  const caller = await requireOwner().catch(() => null);
  if (!caller) return { ok: false, error: 'Not authorized — owner role required.' };

  // Service client — RLS bypassed; caller ownership already verified above.
  const svc = createServiceClient();

  const email = String(args.email ?? '')
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: 'Email required.' };

  // Look up their user_id (may not exist if still pending).
  const { data: adminRow } = await svc
    .from('admin_users')
    .select('user_id, role')
    .eq('email', email)
    .maybeSingle();

  if (!adminRow) {
    // Cancel a pending invite.
    const { error } = await svc.from('pending_admins').delete().eq('email', email);
    if (error) return { ok: false, error: `Couldn't remove invite: ${error.message}` };
    await logEvent({
      action: 'admin.invite_removed',
      entity: email,
      detail: { email },
    });
    return { ok: true };
  }

  // Remove company scope rows first (best-effort; no FK constraint guaranteed).
  await svc.from('admin_companies').delete().eq('admin_email', email);

  const { error } = await svc.from('admin_users').delete().eq('user_id', adminRow.user_id);
  if (error) {
    const msg = /last owner/i.test(error.message)
      ? "You can't remove the last owner."
      : `Couldn't remove admin: ${error.message}`;
    return { ok: false, error: msg };
  }

  await logEvent({
    action: 'admin.removed',
    entity: adminRow.user_id,
    detail: { user_id: adminRow.user_id, email },
  });
  return { ok: true };
}

/**
 * Promote or demote an admin's role, and optionally toggle can_countersign.
 * The DB trigger blocks demoting the last owner.
 * Signature kept identical to the contract file.
 */
export async function setAdminRole(args: {
  email: string;
  role: string;
  canCountersign?: boolean;
}): Promise<ActionResult> {
  const caller = await requireOwner().catch(() => null);
  if (!caller) return { ok: false, error: 'Not authorized — owner role required.' };

  const email = String(args.email ?? '')
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: 'Email required.' };
  const role = args.role === 'owner' ? 'owner' : 'admin';

  // Service client — RLS bypassed; caller ownership already verified above.
  const svc = createServiceClient();

  // We update by email (unique) so we don't need to look up user_id first.
  const patch: { role: string; can_countersign?: boolean } = { role };
  if (typeof args.canCountersign === 'boolean') patch.can_countersign = args.canCountersign;

  // Use the user client to look up user_id for audit (non-privileged read).
  const { data: row } = await (await createServerSupabase())
    .from('admin_users')
    .select('user_id')
    .eq('email', email)
    .maybeSingle();

  const { error } = await svc.from('admin_users').update(patch).eq('email', email);
  if (error) {
    const msg = /last owner/i.test(error.message)
      ? "You can't demote the last owner."
      : `Couldn't change role: ${error.message}`;
    return { ok: false, error: msg };
  }

  await logEvent({
    action: 'admin.role_changed',
    entity: row?.user_id ?? email,
    detail: {
      email,
      role,
      ...(typeof args.canCountersign === 'boolean' ? { can_countersign: args.canCountersign } : {}),
    },
  });
  return { ok: true };
}
