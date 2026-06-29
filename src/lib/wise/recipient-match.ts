/**
 * Pure matcher for "Pull recipient IDs from Wise" (legacy parity).
 *
 * Per Wise recipient, find its contractor:
 *  1. by STORED recipient id, across contractors of ANY status → "already
 *     linked" (an ended contractor that holds the id is still linked; excluding
 *     ended contractors mislabels it "unmatched" and risks a double-link).
 *  2. else by normalized full name, among ACTIVE unlinked contractors only →
 *     "matched" (the caller writes the id onto contractor.id).
 *  3. else → "unmatched" (e.g. a company recipient with no contractor).
 *
 * Pure on purpose: the caller fetches recipients + workers and performs the
 * writes, so this branch logic stays trivially testable.
 */
export type PullRecipientStatus = 'already-linked' | 'matched' | 'unmatched';

export interface MatchWorker {
  id: string;
  name: string;
  status: string;
  wiseRecipientId: number | null;
}
export interface MatchRecipient {
  id: number;
  name: string;
  currency: string;
  account: string;
}
export interface PullRecipientRow {
  recipientId: number;
  name: string;
  currency: string;
  account: string;
  contractor: { id: string; name: string } | null;
  status: PullRecipientStatus;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function planRecipientMatches(
  recipients: MatchRecipient[],
  workers: MatchWorker[],
): PullRecipientRow[] {
  const byId = new Map<number, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  for (const w of workers) {
    const contractor = { id: w.id, name: w.name };
    if (w.wiseRecipientId != null) {
      byId.set(Number(w.wiseRecipientId), contractor);
    } else if (w.status !== 'ended') {
      const key = norm(w.name);
      if (key && !byName.has(key)) byName.set(key, contractor);
    }
  }

  const rows: PullRecipientRow[] = [];
  for (const r of recipients) {
    const base = { recipientId: r.id, name: r.name, currency: r.currency, account: r.account };
    const linked = byId.get(Number(r.id));
    if (linked) {
      rows.push({ ...base, contractor: linked, status: 'already-linked' });
      continue;
    }
    const hit = r.name ? byName.get(norm(r.name)) : undefined;
    if (hit) {
      byName.delete(norm(r.name)); // one recipient per worker
      rows.push({ ...base, contractor: hit, status: 'matched' });
      continue;
    }
    rows.push({ ...base, contractor: null, status: 'unmatched' });
  }

  // Surface linked/matched contractors first, then unmatched; name-sorted within.
  const rank: Record<PullRecipientStatus, number> = {
    'already-linked': 0,
    matched: 1,
    unmatched: 2,
  };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  return rows;
}
