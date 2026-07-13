/**
 * Boundary error-translation (audit #016).
 *
 * Server-action `catch` blocks and per-file `fail` helpers surface a thrown
 * Error's `.message` straight into a toast. Our query layer wraps Postgres
 * failures as `throw new Error(`context: ${pgError.message}`)`, so raw internals
 * ("null value in column \"first_name\" ... violates not-null constraint",
 * "invalid input syntax for type uuid", Zod issue JSON) reach end users on every
 * un-guarded surface. Route those returns through `humanizeError` so the *class*
 * is fixed once, not patched per-surface. App-thrown Errors that already carry
 * human copy pass through unchanged.
 */

import { ZodError } from 'zod';

const humanizeField = (col: string): string => {
  const label = col.replace(/_/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'This field';
};

// Postgres/PostgREST failures arrive as text embedded in a thrown Error message.
// Match the SQLSTATE signature and replace with copy that matches the rest of
// the app. Order matters — first hit wins.
const PG_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /null value in column "([^"]+)".*not-null/is,
    (m) => `${humanizeField(m[1] ?? '')} is required.`,
  ],
  [/duplicate key value violates unique constraint/i, () => 'That already exists.'],
  [/violates foreign key constraint/i, () => "That refers to a record that doesn't exist."],
  [/violates check constraint/i, () => "That value isn't allowed."],
  [/invalid input syntax for type uuid/i, () => 'Not found.'],
  [/value too long for type/i, () => 'That value is too long.'],
];

// Jargon that marks a message as a raw driver leak we didn't explicitly map —
// hide it behind the fallback rather than show internals.
// ponytail: keyword heuristic; add a rule above if a real leak slips through.
const LEAKY = /\b(constraint|relation ")|syntax for type|SQLSTATE|pg_|PGRST\d/i;

export function humanizeError(
  e: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? fallback;
  // Zod-shaped without passing instanceof (dual-bundle edge): first issue message.
  if (e && typeof e === 'object' && Array.isArray((e as { issues?: unknown }).issues)) {
    const first = (e as { issues: Array<{ message?: string }> }).issues[0];
    if (first?.message) return first.message;
  }
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!msg) return fallback;
  for (const [re, fmt] of PG_RULES) {
    const m = msg.match(re);
    if (m) return fmt(m);
  }
  return LEAKY.test(msg) ? fallback : msg;
}

/** Shared `fail` for server actions — same shape every action already returns. */
export const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: humanizeError(e),
});
