'use server';

/**
 * Per-contractor Wise payout management (Profile → Pay & payout).
 *
 * Data model (shared-prod columns on workers, written by the legacy app too):
 *   wise_recipients      jsonb  [{ id, uuid, label }]  — the PRIORITY list:
 *                               index 0 is the default, the rest are failovers
 *   wise_recipient_id    bigint  DERIVED: first entry with a numeric id (API draft)
 *   wise_recipient_uuid  text    DERIVED: first entry with a UUID (manual Batch CSV)
 * See src/lib/wise/recipients.ts for the pure model; every write here goes
 * through recipientColumns() so the columns never drift from the list.
 *
 * Identifiers only — never bank details. No money moves here. But changing a
 * recipient changes WHERE the money lands, so the writes are OWNER-only (RP-56),
 * matching wiseDraft/wiseBatch; the read/lookup paths stay admin. Writes go via
 * the service client (same pattern as wisePullRecipientIds).
 */

import { createServiceClient } from '@/db/clients/service';
import { humanizeError } from '@/lib/errors';
import { otherHolderName } from '@/lib/wise/recipient-match';
import {
  moveRecipientUp,
  promoteRecipient,
  readRecipients,
  recipientColumns,
  removeRecipient,
  setRecipientUuid,
  upsertRecipient,
  type WiseRecipientEntry,
} from '@/lib/wise/recipients';
import { logEvent } from '@/server/audit';
import { requireAdmin, requireOwner } from '@/server/auth/admin';
import {
  explainMissingRecipient,
  type RecipientCheck,
  serviceGetRecipient,
  serviceSearchRecipients,
  serviceVerifyRecipients,
  type WiseRecipientHit,
} from '@/server/wise/service';

export interface WisePayoutState {
  /** Priority order: [0] is the default, the rest are failovers. */
  recipients: WiseRecipientEntry[];
  /** Derived — what the API draft and the Batch CSV will use. */
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
  const recipients = readRecipients(w);
  const cols = recipientColumns(recipients);
  return {
    recipients,
    defaultId: cols.wise_recipient_id,
    uuid: cols.wise_recipient_uuid,
    firstName: w.first_name,
    middleName: w.middle_name,
    lastName: w.last_name,
    email: w.email,
  };
};

type Db = ReturnType<typeof createServiceClient>;

async function readWorker(db: Db, workerId: string) {
  const { data, error } = await db.from('workers').select(SEL).eq('id', workerId).single();
  if (error) throw new Error(error.message);
  return data as WorkerWiseRow;
}

/**
 * RP-55: the partial unique indexes (migration 00000000000031) are the real
 * guard against two contractors sharing one Wise recipient. This pre-check runs
 * first only so the owner sees WHO holds it instead of a duplicate-key error.
 * Returns the blocking message, or null when the write is safe.
 *
 * ponytail: covers the two indexed columns (default id + batch UUID) — the same
 * id sitting unused in another worker's wise_recipients LIST isn't caught until
 * they try to make it their default. Index the jsonb list if that ever bites.
 */
async function recipientTaken(
  db: Db,
  workerId: string,
  col: 'wise_recipient_id' | 'wise_recipient_uuid',
  value: number | string,
): Promise<string | null> {
  const { data } = await db
    .from('workers')
    .select('id, first_name, last_name')
    .eq(col, value as never)
    .limit(5);
  const holder = otherHolderName(data ?? [], workerId);
  if (!holder) return null;
  const what = col === 'wise_recipient_id' ? `Recipient #${value}` : 'That Wise UUID';
  return `${what} is already linked to ${holder}. One recipient is one bank account — remove it there first.`;
}

/**
 * Every write lands here: persist the priority list and the derived columns
 * together, refusing when the NEW default id / UUID belongs to someone else.
 */
async function writeRecipients(
  db: Db,
  workerId: string,
  list: WiseRecipientEntry[],
  audit: { action: string; detail: Record<string, string | number | boolean | null> },
): Promise<Result<WisePayoutState>> {
  const cols = recipientColumns(list);
  if (cols.wise_recipient_id != null) {
    const taken = await recipientTaken(db, workerId, 'wise_recipient_id', cols.wise_recipient_id);
    if (taken) return fail(taken);
  }
  if (cols.wise_recipient_uuid != null) {
    const taken = await recipientTaken(
      db,
      workerId,
      'wise_recipient_uuid',
      cols.wise_recipient_uuid,
    );
    if (taken) return fail(taken);
  }
  const { error } = await db.from('workers').update(cols).eq('id', workerId);
  if (error) return fail(error.message);
  void logEvent({ action: audit.action, entity: workerId, detail: audit.detail });
  return ok(toState(await readWorker(db, workerId)));
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

/**
 * Add a recipient (or merge into the entry that already carries its id/UUID).
 * A bare numeric id — typed, not picked from the Wise search — is checked
 * against Wise first: a deleted or inactive recipient is refused here rather
 * than failing a payroll batch later. Picks from the search carry the UUID
 * and/or came straight from Wise's own list, so they are verified already.
 * New entries go LAST — a failover until the owner promotes it.
 */
export async function addWorkerWiseRecipient(args: {
  workerId: string;
  recipientId?: number | null;
  uuid?: string | null;
  label?: string | null;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireOwner();
    const id = args.recipientId == null ? null : Number(args.recipientId);
    const uuid = args.uuid?.trim() || null;
    if (id != null && (!Number.isInteger(id) || id <= 0)) {
      return fail('Recipient ID must be a positive number.');
    }
    if (id == null && !uuid) return fail('Enter a Wise recipient ID or UUID.');

    let label = args.label?.trim() || '';
    if (id != null && !uuid) {
      const rec = await serviceGetRecipient(id);
      if (!rec) return fail(await explainMissingRecipient(id));
      if (!rec.active) return fail(`Recipient #${id} is inactive in Wise — it can't be paid.`);
      label ||= rec.name;
    }

    const db = createServiceClient();
    if (id != null) {
      const taken = await recipientTaken(db, args.workerId, 'wise_recipient_id', id);
      if (taken) return fail(taken);
    }
    if (uuid) {
      const taken = await recipientTaken(db, args.workerId, 'wise_recipient_uuid', uuid);
      if (taken) return fail(taken);
    }
    const list = upsertRecipient(readRecipients(await readWorker(db, args.workerId)), {
      id,
      uuid,
      label,
    });
    return await writeRecipients(db, args.workerId, list, {
      action: 'wise_recipient_add',
      detail: { recipientId: id, uuid },
    });
  } catch (e) {
    return fail(e);
  }
}

export async function removeWorkerWiseRecipient(args: {
  workerId: string;
  key: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireOwner();
    const db = createServiceClient();
    const list = removeRecipient(readRecipients(await readWorker(db, args.workerId)), args.key);
    return await writeRecipients(db, args.workerId, list, {
      action: 'wise_recipient_remove',
      detail: { key: args.key },
    });
  } catch (e) {
    return fail(e);
  }
}

/** Make `key` the default; the previous default becomes the first failover. */
export async function setDefaultWiseRecipient(args: {
  workerId: string;
  key: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireOwner();
    const db = createServiceClient();
    const cur = readRecipients(await readWorker(db, args.workerId));
    if (!cur.some((e) => (e.uuid ?? String(e.id)) === args.key)) {
      return fail('That recipient is not on this contractor.');
    }
    return await writeRecipients(db, args.workerId, promoteRecipient(cur, args.key), {
      action: 'wise_recipient_default',
      detail: { key: args.key },
    });
  } catch (e) {
    return fail(e);
  }
}

/** Move `key` one step up the failover order. */
export async function moveWiseRecipientUp(args: {
  workerId: string;
  key: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireOwner();
    const db = createServiceClient();
    const cur = readRecipients(await readWorker(db, args.workerId));
    return await writeRecipients(db, args.workerId, moveRecipientUp(cur, args.key), {
      action: 'wise_recipient_reorder',
      detail: { key: args.key },
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Set or clear one entry's Batch-CSV UUID (pasted from Wise → Batch payments →
 * Download all templates — the only place a bank recipient's UUID exists).
 */
export async function saveWorkerWiseUuid(args: {
  workerId: string;
  key: string;
  uuid: string;
}): Promise<Result<WisePayoutState>> {
  try {
    await requireOwner();
    const uuid = args.uuid.trim() || null;
    const db = createServiceClient();
    if (uuid) {
      const taken = await recipientTaken(db, args.workerId, 'wise_recipient_uuid', uuid);
      if (taken) return fail(taken);
    }
    const cur = readRecipients(await readWorker(db, args.workerId));
    return await writeRecipients(db, args.workerId, setRecipientUuid(cur, args.key, uuid), {
      action: 'wise_uuid_save',
      detail: { key: args.key, set: uuid != null },
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Find recipients that already exist in the Wise account — by name, @wisetag,
 * or numeric id — across bank recipients AND Wisetag contacts. Adding a hit
 * stores its id and, when Wise exposes it, its UUID.
 */
export async function searchWiseRecipients(query: string): Promise<Result<WiseRecipientHit[]>> {
  try {
    await requireAdmin();
    if (!query.trim()) return fail('Enter a name, @wisetag, or recipient ID.');
    return ok(await serviceSearchRecipients(query));
  } catch (e) {
    return fail(e);
  }
}

/** Check every saved recipient against Wise (see serviceVerifyRecipients). */
export async function verifyWorkerWiseRecipients(
  workerId: string,
): Promise<Result<RecipientCheck[]>> {
  try {
    await requireAdmin();
    const db = createServiceClient();
    return ok(await serviceVerifyRecipients(readRecipients(await readWorker(db, workerId))));
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
    await requireOwner();
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
