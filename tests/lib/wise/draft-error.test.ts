import { describe, expect, it } from 'vitest';
import { classifyDraftError } from '@/lib/wise/draft-error';

// Shape that wiseRequest throws.
const wiseErr = (status: number, body: string) =>
  new Error(`Wise API POST /v1/transfers → ${status}: ${body}`);

describe('classifyDraftError', () => {
  it('classifies a 422 non-bank recipient as wisetag_unsupported', () => {
    const e = wiseErr(422, '{"errors":[{"path":"targetAccount","message":"not a bank account"}]}');
    expect(classifyDraftError('transfer: ', e)).toBe('wisetag_unsupported');
  });

  it('classifies a 403 balance recipient as wisetag_unsupported', () => {
    expect(classifyDraftError('', wiseErr(403, 'recipient is a balance account'))).toBe(
      'wisetag_unsupported',
    );
  });

  it('passes an unrelated error through with its prefix', () => {
    const e = wiseErr(500, 'internal error');
    expect(classifyDraftError('transfer: ', e)).toBe(`transfer: ${String(e)}`);
  });

  it('does not misclassify a 422 that lacks recipient wording', () => {
    const e = wiseErr(422, 'quote expired');
    expect(classifyDraftError('', e)).toBe(String(e));
  });
});
