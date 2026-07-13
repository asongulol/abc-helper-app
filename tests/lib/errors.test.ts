import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fail, humanizeError } from '@/lib/errors';

describe('humanizeError (#016 boundary translation)', () => {
  it('turns a raw not-null Postgres leak into a required-field message', () => {
    const e = new Error(
      'updateOwnProfile: null value in column "first_name" of relation "workers" violates not-null constraint',
    );
    expect(humanizeError(e)).toBe('First name is required.');
  });

  it('hides other raw Postgres/PostgREST internals behind the fallback', () => {
    expect(humanizeError(new Error('duplicate key value violates unique constraint "x"'))).toBe(
      'That already exists.',
    );
    expect(humanizeError(new Error('invalid input syntax for type uuid: "junk"'))).toBe(
      'Not found.',
    );
    // unmapped-but-clearly-internal → fallback, never shown verbatim
    expect(humanizeError(new Error('relation "workers" does not exist'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('surfaces the first Zod issue message, not the JSON blob', () => {
    const r = z
      .object({ n: z.number().positive('Must be a positive number.') })
      .safeParse({ n: -1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(humanizeError(r.error)).toBe('Must be a positive number.');
  });

  it('passes app-thrown human copy through unchanged', () => {
    expect(
      humanizeError(new Error('A live invoice already exists for this client + period.')),
    ).toBe('A live invoice already exists for this client + period.');
  });

  it('fail() wraps the translated message in the standard action shape', () => {
    expect(fail(new Error('invalid input syntax for type uuid'))).toEqual({
      ok: false,
      error: 'Not found.',
    });
  });
});
