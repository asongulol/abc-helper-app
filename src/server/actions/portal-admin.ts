'use server';

/**
 * Portal-admin actions — CONTRACT FILE (legacy edge fn `portal-admin`).
 * Implementations are filled in by the server-layer build; admin screens code
 * against these signatures.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string };

const notWired = (): never => {
  throw new Error('portal-admin actions not wired yet — see src/server/actions/portal-admin.ts');
};

/** Create a portal login for a worker (sends the hire email with credentials). */
export async function createPortalLogin(_args: {
  workerId: string;
  email: string;
}): Promise<ActionResult<{ tempPassword?: string }>> {
  return notWired();
}

export async function resetPortalPassword(_args: {
  workerId: string;
}): Promise<ActionResult<{ tempPassword?: string }>> {
  return notWired();
}

export async function revokePortalLogin(_args: { workerId: string }): Promise<ActionResult> {
  return notWired();
}

export async function resendHireEmails(_args: { workerId: string }): Promise<ActionResult> {
  return notWired();
}

export async function sendToolsEmail(_args: { workerId: string }): Promise<ActionResult> {
  return notWired();
}

/** Full contractor deletion (auth user + rows). Owner-gated, destructive. */
export async function deleteContractor(_args: { workerId: string }): Promise<ActionResult> {
  return notWired();
}
