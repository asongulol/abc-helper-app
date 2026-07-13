'use server';

/**
 * Per-contractor Wise payout management (Profile → Pay & payout), legacy parity
 * for the "Wise recipients" list + "External sources — Wise drift".
 *
 * Data model (shared-prod columns on workers, written by the legacy app too):
 *   wise_recipients      jsonb  [{ id:number, label:string }]   — the recipient list
 *   wise_recipient_id    bigint  the DEFAULT recipient (last used)
 *   wise_recipient_uuid  text    the manual Batch-CSV UUID (separate; Wise API
 *                                 never returns it)
 *
 * Identifiers only — never bank details. No money moves here. Admin-gated;
 * writes via the service client (same pattern as wisePullRecipientIds).
 */

import { createServiceClient } from '@/db/clients/service';
import { humanizeError } from '@/lib/errors';
import { logEvent } from '@/server/audit';
import { requireAdmin } from '@/server/auth/admin';
import {
  explainMissingRecipient,
  serviceGetRecipient,
  serviceSearchContacts,
} from '@/server/wise/service';

export type WiseRecipientRow = { id: number; label: string };
export interface WisePayoutState {
  recipients: WiseRecipientRow[];
  defaultId: number | null;
  uuid: string | null;
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string | null;
}
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(e: unknown): Result<T> => ({
  ok: false,
  error: humanizeError(e, 'Failed'),
});

type WorkerWiseRow = {
  first_name: string;
  middle_name: string | null;
  last_name: string;
  email: string | null;
  wise_recipients: unknown;
  wise_recipient_id: number | null;
  wise_recipient_uuid: string | null;
};

const SEL =
  'first_name, middle_name, last_name, email, wise_recipients, wise_recipient_id, wise_recipient_uuid';

const toState = (w: WorkerWiseRow): WisePayoutState => {
  const list = Array.isArray(w.wise_recipients) ? (w.wise_recipients as WiseRecipientRow[]) : [];
  return {
    recipients: list
      .filter((r) => r && typeof r.id === 'number')
      .map((r) => ({ id: r.id, label: String(r.label ?? `Recipient ${r.id}`) })),
    defaultId: w.wise_recipient_id ?? null,
    uuid: w.wise_recipient_uuid ?? null,
    firstName: w.first_name,
    middleName: w.middle_name,
    lastName: w.last_name,
    email: w.email,
  };
};

async function readWorker(db: ReturnType<typeof createServiceClient>, workerId: string) {
  const { data, error } = await db.from('workers').select(SEL).eq('id', workerId).single();
  if (error) throw new Error(error.message);
  return data as WorkerWiseRow;
}

export async function getWorkerWisePayout(workerId: string): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const db = createServiceClient();
    return ok(toState(await readWorker(db, workerId)));
  } catch (e) {
    return fail(e);
  }
}

export async function addWorkerWiseRecipient(args: {
  workerId: string;
  recipientId: number;
  label?: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const id = Number(args.recipientId);
    if (!Number.isInteger(id) || id <= 0) return fail('Recipient ID must be a positive number.');

    const db = createServiceClient();
    const w = await readWorker(db, args.workerId);
    const state = toState(w);
    if (state.recipients.some((r) => r.id === id)) return ok(state); // already added

    const next = [...state.recipients, { id, label: args.label?.trim() || `Recipient ${id}` }];
    const nextDefault = state.defaultId ?? id; // first one becomes default
    const { error } = await db
      .from('workers')
      .update({ wise_recipients: next, wise_recipient_id: nextDefault })
      .eq('id', args.workerId);
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_recipient_add',
      entity: args.workerId,
      detail: { recipientId: id },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}

export async function removeWorkerWiseRecipient(args: {
  workerId: string;
  recipientId: number;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const db = createServiceClient();
    const state = toState(await readWorker(db, args.workerId));
    const next = state.recipients.filter((r) => r.id !== args.recipientId);
    const nextDefault =
      state.defaultId === args.recipientId ? (next[0]?.id ?? null) : state.defaultId;
    const { error } = await db
      .from('workers')
      .update({ wise_recipients: next, wise_recipient_id: nextDefault })
      .eq('id', args.workerId);
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_recipient_remove',
      entity: args.workerId,
      detail: { recipientId: args.recipientId },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}

export async function setDefaultWiseRecipient(args: {
  workerId: string;
  recipientId: number;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const db = createServiceClient();
    const state = toState(await readWorker(db, args.workerId));
    if (!state.recipients.some((r) => r.id === args.recipientId)) {
      return fail('That recipient is not on this contractor.');
    }
    const { error } = await db
      .from('workers')
      .update({ wise_recipient_id: args.recipientId })
      .eq('id', args.workerId);
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_recipient_default',
      entity: args.workerId,
      detail: { recipientId: args.recipientId },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}

export async function saveWorkerWiseUuid(args: {
  workerId: string;
  uuid: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const uuid = args.uuid.trim() || null;
    const db = createServiceClient();
    const { error } = await db
      .from('workers')
      .update({ wise_recipient_uuid: uuid })
      .eq('id', args.workerId);
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_uuid_save',
      entity: args.workerId,
      detail: { set: uuid != null },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}

/**
 * "By Wisetag" lookup: search Wise CONTACTS (Wise-to-Wise / balance recipients)
 * by Wisetag or name. Each result carries the contact UUID (== wise_recipient_uuid,
 * the manual Batch-CSV recipientId) AND the numeric balanceRecipientId
 * (== wise_recipient_id). Pick one and addWorkerWiseContact stores both, so the
 * contractor lands in the downloadable Wise batch file without a manual paste.
 */
export async function lookupWiseByTag(
  query: string,
): Promise<Result<{ recipientId: number; uuid: string; name: string }[]>> {
  try {
    await requireAdmin();
    const term = query.trim().replace(/^@/, '');
    if (!term) return fail('Enter a Wisetag or name.');
    // Wise ignores ?searchTerm and returns ALL balance contacts, so filter by
    // name client-side; fall back to the full list when nothing matches (a
    // Wisetag often differs from the display name).
    const all = (await serviceSearchContacts(term)).map((c) => ({
      recipientId: c.recipientId,
      uuid: c.uuid,
      name: c.name || `Recipient ${c.uuid.slice(0, 8)}`,
    }));
    const t = term.toLowerCase();
    const flat = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const hits = all.filter((c) => c.name.toLowerCase().includes(t) || flat(c.name).includes(t));
    return ok(hits.length ? hits : all);
  } catch (e) {
    return fail(e);
  }
}

/**
 * Add a Wisetag/balance contact picked from lookupWiseByTag: store its UUID
 * (the Batch-CSV recipientId) and, when present, its numeric balanceRecipientId
 * (added to the recipients list + set as default for the API-draft attempt).
 * The UUID is what actually gets a balance recipient into the batch file.
 */
export async function addWorkerWiseContact(args: {
  workerId: string;
  recipientId: number;
  uuid: string;
  label?: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const uuid = args.uuid.trim();
    if (!uuid) return fail('That Wisetag contact has no UUID.');
    const id = Number(args.recipientId);
    const hasId = Number.isInteger(id) && id > 0;

    const db = createServiceClient();
    const state = toState(await readWorker(db, args.workerId));
    const label = args.label?.trim() || `Recipient ${hasId ? id : uuid.slice(0, 8)}`;
    const recipients =
      hasId && !state.recipients.some((r) => r.id === id)
        ? [...state.recipients, { id, label }]
        : state.recipients;
    const nextDefault = hasId ? (state.defaultId ?? id) : state.defaultId;

    const { error } = await db
      .from('workers')
      .update({
        wise_recipient_uuid: uuid,
        wise_recipients: recipients,
        wise_recipient_id: nextDefault,
      })
      .eq('id', args.workerId);
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_contact_add',
      entity: args.workerId,
      detail: { recipientId: hasId ? id : null, uuid },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}

/**
 * Wise drift: pull Wise's name or email into the DB (Wise is the payment source
 * of truth). Name is split first / middle / last from Wise's single string.
 */
export async function applyWiseDriftToWorker(args: {
  workerId: string;
  field: 'name' | 'email';
  recipientId: number;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireAdmin();
    const rec = await serviceGetRecipient(Number(args.recipientId));
    if (!rec) return fail(await explainMissingRecipient(Number(args.recipientId)));

    const db = createServiceClient();
    let error: { message: string } | null;
    if (args.field === 'email') {
      ({ error } = await db
        .from('workers')
        .update({ email: rec.email?.trim() || null })
        .eq('id', args.workerId));
    } else {
      const parts = (rec.name ?? '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return fail('Wise has no name for this recipient.');
      const first = parts[0] ?? '';
      const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
      const middle = parts.length > 2 ? parts.slice(1, -1).join(' ') : null;
      ({ error } = await db
        .from('workers')
        .update({ first_name: first, middle_name: middle, last_name: last })
        .eq('id', args.workerId));
    }
    if (error) return fail(error.message);
    void logEvent({
      action: 'wise_drift_pull',
      entity: args.workerId,
      detail: { field: args.field, recipientId: args.recipientId },
    });
    return ok(toState(await readWorker(db, args.workerId)));
  } catch (e) {
    return fail(e);
  }
}
