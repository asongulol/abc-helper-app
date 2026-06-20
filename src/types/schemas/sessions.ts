/**
 * Zod schemas for per-session billing trust boundaries (server-action inputs).
 * Mirrors src/types/schemas/time.ts. Sessions are client-scoped, so the company
 * id here is always the CLIENT being billed.
 */

import { z } from 'zod';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** Load a client's roster + sessions for a window (management screen). */
export const LoadSessionsSchema = z.object({
  clientId: z.string().uuid(),
  from: IsoDateSchema,
  to: IsoDateSchema,
});
export type LoadSessionsInput = z.infer<typeof LoadSessionsSchema>;

/** Record one session/visit (flat-fee unit). */
export const CreateSessionSchema = z.object({
  clientId: z.string().uuid(),
  workerId: z.string().uuid(),
  sessionDate: IsoDateSchema,
  sessionType: z.string().max(100).nullable().optional(),
  units: z.number().int().min(1).max(1000),
  caseRef: z.string().max(100).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/** Approve / reject / reset a set of sessions. Only approved sessions bill. */
export const SetSessionApprovalSchema = z.object({
  clientId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1),
  status: z.enum(['approved', 'rejected', 'pending']),
});
export type SetSessionApprovalInput = z.infer<typeof SetSessionApprovalSchema>;

/** Delete a single session row. */
export const DeleteSessionSchema = z.object({
  clientId: z.string().uuid(),
  id: z.string().uuid(),
});
export type DeleteSessionInput = z.infer<typeof DeleteSessionSchema>;
