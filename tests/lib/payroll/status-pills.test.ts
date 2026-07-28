import { describe, expect, it } from 'vitest';
import {
  isUnfundedWiseDraft,
  isUnpaidStatus,
  type PaymentStatus,
  paymentStatusLabel,
  paymentStatusTone,
  payoutMethodLabel,
  periodStateLabel,
  periodStateTone,
} from '@/lib/payroll/status-pills';

const ALL: PaymentStatus[] = ['draft', 'queued', 'sent', 'failed', 'reconciled'];

describe('periodState pills', () => {
  it('maps each pay-period state', () => {
    expect([periodStateLabel('open'), periodStateTone('open')]).toEqual(['draft', 'warn']);
    expect([periodStateLabel('locked'), periodStateTone('locked')]).toEqual(['locked', 'neutral']);
    expect([periodStateLabel('paid'), periodStateTone('paid')]).toEqual(['paid', 'good']);
  });
});

describe('paymentStatus pills (RP-57 — all five enum states are distinct)', () => {
  it('labels every state distinctly', () => {
    expect(ALL.map(paymentStatusLabel)).toEqual([
      'unpaid',
      'queued',
      'paid',
      'failed',
      'reconciled',
    ]);
  });

  it('never renders money-moved or failed states as a neutral pill', () => {
    // The /process bug: reconciled and failed both showed as neutral "pending".
    expect(paymentStatusTone('reconciled')).toBe('good');
    expect(paymentStatusTone('sent')).toBe('good');
    expect(paymentStatusTone('failed')).toBe('bad');
    expect(paymentStatusTone('queued')).toBe('warn');
    expect(paymentStatusTone('draft')).toBe('neutral');
  });
});

describe('isUnpaidStatus (RP-08 — what "Mark all paid" may flip)', () => {
  it('accepts only the three pre-payment states', () => {
    expect(ALL.filter(isUnpaidStatus)).toEqual(['draft', 'queued', 'failed']);
  });

  it('refuses sent and reconciled — re-marking overwrites their true send date', () => {
    expect(isUnpaidStatus('sent')).toBe(false);
    expect(isUnpaidStatus('reconciled')).toBe(false);
  });
});

describe('isUnfundedWiseDraft (RP-58 — drafts that look payable but moved no money)', () => {
  const wiseDraft = {
    status: 'draft' as PaymentStatus,
    payoutMethod: 'wise',
    wiseTransferId: '99',
  };

  it('flags a Wise row whose draft transfer exists but is unpaid', () => {
    expect(isUnfundedWiseDraft(wiseDraft)).toBe(true);
    expect(isUnfundedWiseDraft({ ...wiseDraft, status: 'failed' })).toBe(true);
  });

  it('ignores a Wise row with no draft transfer yet', () => {
    expect(isUnfundedWiseDraft({ ...wiseDraft, wiseTransferId: null })).toBe(false);
  });

  it('ignores non-Wise rows', () => {
    expect(isUnfundedWiseDraft({ ...wiseDraft, payoutMethod: 'bpi' })).toBe(false);
    expect(isUnfundedWiseDraft({ ...wiseDraft, payoutMethod: null })).toBe(false);
  });

  it('ignores a Wise draft that has already been funded and sent', () => {
    expect(isUnfundedWiseDraft({ ...wiseDraft, status: 'sent' })).toBe(false);
    expect(isUnfundedWiseDraft({ ...wiseDraft, status: 'reconciled' })).toBe(false);
  });
});

describe('payoutMethodLabel', () => {
  it('labels known methods and marks an unset one', () => {
    expect(payoutMethodLabel('wise')).toBe('Wise');
    expect(payoutMethodLabel('gcash')).toBe('GCash');
    expect(payoutMethodLabel(null)).toBe('— unset —');
  });
});
