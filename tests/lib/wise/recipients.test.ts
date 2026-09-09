import { describe, expect, it } from 'vitest';
import {
  draftCandidates,
  moveRecipientUp,
  promoteRecipient,
  readRecipients,
  recipientColumns,
  removeRecipient,
  setRecipientUuid,
  upsertRecipient,
} from '@/lib/wise/recipients';

const bank = { id: 111, uuid: 'aaaa-1', label: 'BPI' };
const tag = { id: 222, uuid: 'bbbb-2', label: 'Wisetag' };

describe('readRecipients — every shape on the shared DB', () => {
  it('keeps the legacy per-entry uuid and puts the default first', () => {
    // Mery-style legacy row: default is the SECOND list entry.
    const list = readRecipients({
      wise_recipients: [bank, tag],
      wise_recipient_id: 222,
      wise_recipient_uuid: 'bbbb-2',
    });
    expect(list).toEqual([tag, bank]);
  });

  it('attaches a column uuid to a default entry that has none (pre-list model)', () => {
    const list = readRecipients({
      wise_recipients: [{ id: 222, label: 'Hazzan (Wisetag)' }],
      wise_recipient_id: 222,
      wise_recipient_uuid: 'bbbb-2',
    });
    expect(list).toEqual([{ id: 222, uuid: 'bbbb-2', label: 'Hazzan (Wisetag)' }]);
  });

  it('synthesises entries for a bare id or a uuid-only worker', () => {
    expect(
      readRecipients({ wise_recipients: [], wise_recipient_id: 5, wise_recipient_uuid: null }),
    ).toEqual([{ id: 5, uuid: null, label: 'Recipient 5' }]);
    expect(
      readRecipients({
        wise_recipients: null,
        wise_recipient_id: null,
        wise_recipient_uuid: 'cccc-3',
      }),
    ).toEqual([{ id: null, uuid: 'cccc-3', label: 'Recipient cccc-3' }]);
  });

  it('drops junk and duplicates', () => {
    const list = readRecipients({
      wise_recipients: [null, { label: 'x' }, bank, { id: 111, label: 'dup' }],
      wise_recipient_id: null,
      wise_recipient_uuid: null,
    });
    expect(list).toEqual([bank]);
  });
});

describe('recipientColumns — each route takes the first entry that serves it', () => {
  it('derives id and uuid independently from priority order', () => {
    const cols = recipientColumns([
      { id: null, uuid: 'bank-uuid', label: 'Bank (uuid only)' },
      { id: 222, uuid: 'tag-uuid', label: 'Wisetag' },
    ]);
    expect(cols.wise_recipient_id).toBe(222);
    expect(cols.wise_recipient_uuid).toBe('bank-uuid');
    expect(cols.wise_recipients).toHaveLength(2);
  });
  it('nulls both when the list is empty', () => {
    expect(recipientColumns([])).toEqual({
      wise_recipients: [],
      wise_recipient_id: null,
      wise_recipient_uuid: null,
    });
  });
});

describe('ordering', () => {
  it('promote moves an entry to the front; the old default becomes the first failover', () => {
    const third = { id: 333, uuid: null, label: 'GCash' };
    expect(promoteRecipient([bank, tag, third], '333')).toEqual([third, bank, tag]);
    expect(promoteRecipient([bank, tag], 'aaaa-1')).toEqual([bank, tag]);
    expect(promoteRecipient([bank, tag], 'nope')).toEqual([bank, tag]);
  });
  it('moveUp swaps with the entry above', () => {
    const third = { id: 333, uuid: null, label: 'GCash' };
    expect(moveRecipientUp([bank, tag, third], '333')).toEqual([bank, third, tag]);
    expect(moveRecipientUp([bank, tag], 'aaaa-1')).toEqual([bank, tag]);
  });
  it('remove drops by key (uuid when present, else id)', () => {
    expect(removeRecipient([bank, tag], 'bbbb-2')).toEqual([bank]);
    expect(removeRecipient([{ id: 9, uuid: null, label: 'x' }], '9')).toEqual([]);
  });
});

describe('upsertRecipient', () => {
  it('appends a new recipient LAST (a failover until promoted)', () => {
    expect(upsertRecipient([bank], { id: 333, label: 'GCash' })).toEqual([
      bank,
      { id: 333, uuid: null, label: 'GCash' },
    ]);
  });
  it('merges into the entry with the same id, filling a missing uuid in place', () => {
    const cur = [{ id: 222, uuid: null, label: 'Wisetag' }, bank];
    expect(upsertRecipient(cur, { id: 222, uuid: 'bbbb-2', label: 'ignored' })).toEqual([
      { id: 222, uuid: 'bbbb-2', label: 'Wisetag' },
      bank,
    ]);
  });
  it('merges by uuid and fills a missing id; a placeholder label gets the real name', () => {
    const cur = [{ id: null, uuid: 'aaaa-1', label: 'Recipient aaaa-1' }];
    expect(upsertRecipient(cur, { id: 111, uuid: 'aaaa-1', label: 'BPI' })).toEqual([bank]);
  });
});

describe('setRecipientUuid', () => {
  it('sets the uuid on one entry and takes it off any other', () => {
    const cur = [
      { id: 222, uuid: 'bank-uuid', label: 'Wisetag (uuid pasted over it)' },
      { id: 111, uuid: null, label: 'BPI' },
    ];
    expect(setRecipientUuid(cur, '111', 'bank-uuid')).toEqual([
      { id: 222, uuid: null, label: 'Wisetag (uuid pasted over it)' },
      { id: 111, uuid: 'bank-uuid', label: 'BPI' },
    ]);
  });
  it('clears with null / blank', () => {
    expect(setRecipientUuid([bank], 'aaaa-1', '  ')).toEqual([{ ...bank, uuid: null }]);
  });
});

describe('draftCandidates — API-draft order with failovers', () => {
  const worker = { wise_recipient_id: 222, wise_recipients: [bank, tag, { id: 333 }] };
  it('default first, then the rest of the list, deduped', () => {
    expect(draftCandidates(worker)).toEqual([222, 111, 333]);
  });
  it('an override goes first; the default becomes a failover', () => {
    expect(draftCandidates(worker, 333)).toEqual([333, 222, 111]);
  });
  it('ignores uuid-only entries and a missing worker', () => {
    expect(draftCandidates({ wise_recipients: [{ uuid: 'x' }] })).toEqual([]);
    expect(draftCandidates(null)).toEqual([]);
  });
});
