/**
 * A contractor's Wise recipients, in PRIORITY order — pure, no DB.
 *
 * One contractor can hold several ways to be paid in Wise (a bank account, a
 * Wisetag / balance contact, a second bank). Each is one entry:
 *
 *   id    — numeric Wise recipient id, the API-draft key (POST /v1/transfers
 *           targetAccount). Balance/Wisetag ids usually 422 on draft.
 *   uuid  — the recipient UUID, the manual Batch-CSV `recipientId`. Wisetag
 *           contacts expose it via the contacts API; a bank recipient's UUID
 *           comes from Wise → Batch payments → Download all templates.
 *   label — display only.
 *
 * Index 0 is the DEFAULT; the rest are failovers in order. The three worker
 * columns are DERIVED from that order (`recipientColumns`): each payout route
 * takes the first entry that can serve it, so the CSV builder, the matcher, the
 * legacy portal and the RP-55 unique indexes keep reading the columns unchanged.
 */

export interface WiseRecipientEntry {
  id: number | null;
  uuid: string | null;
  label: string;
}

/** Stable handle for one entry: its UUID when it has one, else its numeric id. */
export const entryKey = (e: { id: number | null; uuid: string | null }): string =>
  e.uuid ?? String(e.id);

const asId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const asUuid = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

export const defaultLabel = (id: number | null, uuid: string | null): string =>
  id != null ? `Recipient ${id}` : `Recipient ${(uuid ?? '').slice(0, 8)}`;

/**
 * Read a worker's recipients in priority order, tolerating every shape on the
 * shared DB: legacy `[{id,uuid,label}]`, the older new-app `[{id,label}]`, and
 * a bare `wise_recipient_id` / `wise_recipient_uuid` no list entry carries
 * (synthesised as an entry so nothing stored is invisible).
 *
 * A column UUID no entry holds is attached to the default entry when that one
 * has none — the pre-list model was one person = one id + one UUID. Wrong only
 * when the owner pasted a DIFFERENT recipient's UUID over the default's; the
 * fix there is "Add" the right recipient from Wise and move the UUID to it.
 */
export const readRecipients = (w: {
  wise_recipients: unknown;
  wise_recipient_id: number | null;
  wise_recipient_uuid: string | null;
}): WiseRecipientEntry[] => {
  const raw = Array.isArray(w.wise_recipients) ? w.wise_recipients : [];
  const list: WiseRecipientEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = asId(o.id);
    const uuid = asUuid(o.uuid);
    if (id == null && uuid == null) continue;
    if (list.some((e) => (id != null && e.id === id) || (uuid != null && e.uuid === uuid)))
      continue;
    list.push({ id, uuid, label: String(o.label ?? '').trim() || defaultLabel(id, uuid) });
  }
  const defId = asId(w.wise_recipient_id);
  const defUuid = asUuid(w.wise_recipient_uuid);
  if (defId != null && !list.some((e) => e.id === defId)) {
    list.unshift({ id: defId, uuid: null, label: defaultLabel(defId, null) });
  }
  // Default first — legacy rows keep the default anywhere in the list.
  const di = defId == null ? -1 : list.findIndex((e) => e.id === defId);
  if (di > 0) list.unshift(...list.splice(di, 1));
  if (defUuid != null && !list.some((e) => e.uuid === defUuid)) {
    const first = list[0];
    if (first && first.uuid == null) first.uuid = defUuid;
    else list.push({ id: null, uuid: defUuid, label: defaultLabel(null, defUuid) });
  }
  return list;
};

/** The worker columns derived from priority order (see header). */
export const recipientColumns = (list: readonly WiseRecipientEntry[]) => ({
  wise_recipients: list.map((e) => ({ id: e.id, uuid: e.uuid, label: e.label })),
  wise_recipient_id: list.find((e) => e.id != null)?.id ?? null,
  wise_recipient_uuid: list.find((e) => e.uuid != null)?.uuid ?? null,
});

const indexOf = (list: readonly WiseRecipientEntry[], key: string): number =>
  list.findIndex((e) => entryKey(e) === key);

/** Move `key` to the front — it becomes the default; the old default is the first failover. */
export const promoteRecipient = (
  list: readonly WiseRecipientEntry[],
  key: string,
): WiseRecipientEntry[] => {
  const i = indexOf(list, key);
  if (i <= 0) return [...list];
  return [list[i] as WiseRecipientEntry, ...list.slice(0, i), ...list.slice(i + 1)];
};

/** Swap `key` with the entry above it (failover ordering). */
export const moveRecipientUp = (
  list: readonly WiseRecipientEntry[],
  key: string,
): WiseRecipientEntry[] => {
  const i = indexOf(list, key);
  if (i <= 0) return [...list];
  const next = [...list];
  [next[i - 1], next[i]] = [next[i] as WiseRecipientEntry, next[i - 1] as WiseRecipientEntry];
  return next;
};

export const removeRecipient = (
  list: readonly WiseRecipientEntry[],
  key: string,
): WiseRecipientEntry[] => list.filter((e) => entryKey(e) !== key);

/**
 * Add an entry, or MERGE into the one sharing its id or UUID — re-adding a
 * Wisetag contact from the Wise search restores a UUID a paste overwrote, and a
 * bank recipient added by id later gains its UUID without a duplicate row.
 * Blank fields never overwrite stored ones. Appended entries go LAST (a new
 * recipient is a failover until the owner promotes it); a merge keeps its place.
 */
export const upsertRecipient = (
  list: readonly WiseRecipientEntry[],
  entry: { id?: number | null; uuid?: string | null; label?: string | null },
): WiseRecipientEntry[] => {
  const id = asId(entry.id);
  const uuid = asUuid(entry.uuid);
  const label = (entry.label ?? '').trim();
  const i = list.findIndex((e) => (id != null && e.id === id) || (uuid != null && e.uuid === uuid));
  if (i === -1) {
    return [...list, { id, uuid, label: label || defaultLabel(id, uuid) }];
  }
  const cur = list[i] as WiseRecipientEntry;
  const merged: WiseRecipientEntry = {
    id: cur.id ?? id,
    uuid: cur.uuid ?? uuid,
    label: cur.label.startsWith('Recipient ') && label ? label : cur.label,
  };
  return list.map((e, j) => (j === i ? merged : e));
};

/** Set (or clear) one entry's UUID; a UUID is one account, so it leaves any other entry it was on. */
export const setRecipientUuid = (
  list: readonly WiseRecipientEntry[],
  key: string,
  uuid: string | null,
): WiseRecipientEntry[] => {
  const v = asUuid(uuid);
  return list.map((e) =>
    entryKey(e) === key ? { ...e, uuid: v } : v != null && e.uuid === v ? { ...e, uuid: null } : e,
  );
};

/**
 * Numeric ids to try for an API draft, in order: the per-row override (or the
 * default) first, then every other saved id as a failover. A draft that Wise
 * rejects at one recipient (a Wisetag that isn't bank-fundable) moves to the next.
 */
export const draftCandidates = (
  worker: { wise_recipient_id?: number | null; wise_recipients?: unknown } | null | undefined,
  override?: number | null,
): number[] => {
  const raw = Array.isArray(worker?.wise_recipients) ? worker.wise_recipients : [];
  const ordered = [
    override,
    worker?.wise_recipient_id,
    ...raw.map((r) => (r as { id?: unknown } | null)?.id),
  ]
    .map(asId)
    .filter((n): n is number => n != null);
  return [...new Set(ordered)];
};
