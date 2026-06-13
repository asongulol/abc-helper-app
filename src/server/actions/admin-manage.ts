'use server';

/**
 * Admin management actions — CONTRACT FILE (legacy edge fn `admin-manage`).
 * Implementations are filled in by the server-layer build.
 */

import type { ActionResult } from '@/server/actions/portal-admin';

const notWired = (): never => {
  throw new Error('admin-manage actions not wired yet — see src/server/actions/admin-manage.ts');
};

export async function addAdmin(_args: {
  email: string;
  name?: string;
  role: string;
  companyIds: string[];
}): Promise<ActionResult> {
  return notWired();
}

export async function removeAdmin(_args: { email: string }): Promise<ActionResult> {
  return notWired();
}

export async function setAdminRole(_args: {
  email: string;
  role: string;
  canCountersign?: boolean;
}): Promise<ActionResult> {
  return notWired();
}
