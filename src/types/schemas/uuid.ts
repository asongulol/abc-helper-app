import { z } from 'zod';

/**
 * UUID-shaped id validator.
 *
 * Accepts any 8-4-4-4-12 hex string — INCLUDING ids whose version/variant bits
 * are not RFC-4122-compliant. The shared production database carries seeded ids
 * like `a0000000-0000-0000-0000-000000000022`, and Zod v4 tightened
 * `z.string().uuid()` to reject those ("Invalid UUID"), which broke every action
 * that validates a worker/company/payment id (e.g. saving a contractor profile).
 * These ids come from our own database, not untrusted input, so a format
 * sanity-check is sufficient. Use this instead of `z.string().uuid()` everywhere.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuid = (message = 'Invalid id') => z.string().regex(UUID_RE, message);
