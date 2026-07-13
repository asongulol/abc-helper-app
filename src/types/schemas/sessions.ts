/**
 * Zod schemas for per-session billing trust boundaries (server-action inputs).
 * Mirrors src/types/schemas/time.ts. Sessions are client-scoped, so the company
 * id here is always the CLIENT being billed.
 */

import { z } from 'zod';
import { uuid } from './uuid';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/**
 * Billable session items a contractor chooses from in the portal (stored in
 * service_sessions.session_type). Extend this list to add more meeting types.
 */
export const EI_SESSION_ITEMS = ['Initial IFSP', 'Amendment IFSP'] as const;
export type EiSessionItem = (typeof EI_SESSION_ITEMS)[number];

/** Load a client's roster + sessions for a window (management screen). */
export const LoadSessionsSchema = z.object({
  clientId: uuid(),
  from: IsoDateSchema,
  to: IsoDateSchema,
});
export type LoadSessionsInput = z.infer<typeof LoadSessionsSchema>;

/** Record one session/visit (flat-fee unit) — admin entry. */
export const CreateSessionSchema = z.object({
  clientId: uuid(),
  workerId: uuid(),
  sessionDate: IsoDateSchema,
  sessionType: z.string().max(100).nullable().optional(),
  units: z.number().int().min(1).max(1000),
  childInitials: z.string().max(12).nullable().optional(),
  eiid: z.string().max(40).nullable().optional(),
  caseRef: z.string().max(100).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  /** Admin entry is authoritative — mark approved immediately (so it pays/bills
   *  without a separate review step). Omitted/false ⇒ pending (portal/CSV flow). */
  approve: z.boolean().optional(),
  /** When true, skip the same-worker/client/date duplicate soft-warn (caller
   *  already confirmed this is a genuine second visit that day). */
  confirmDuplicate: z.boolean().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

/** Edit a still-PENDING session (approved ones are locked — they already bill). */
export const UpdateSessionSchema = z.object({
  clientId: uuid(),
  id: uuid(),
  sessionDate: IsoDateSchema,
  sessionType: z.string().max(100).nullable().optional(),
  units: z.number().int().min(1).max(1000),
  childInitials: z.string().max(12).nullable().optional(),
  eiid: z.string().max(40).nullable().optional(),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionSchema>;

/**
 * Record one session from the CONTRACTOR portal. The worker is the logged-in
 * contractor (not supplied by the client); the item is constrained to
 * EI_SESSION_ITEMS and stored as session_type; units default to 1.
 */
export const CreateContractorSessionSchema = z.object({
  clientId: uuid(),
  sessionDate: IsoDateSchema,
  item: z.enum(EI_SESSION_ITEMS),
  childInitials: z.string().trim().min(1, 'Required').max(12),
  eiid: z.string().trim().min(1, 'Required').max(40),
  notes: z.string().max(1000).nullable().optional(),
  /** When true, skip the same-client/date duplicate soft-warn (contractor
   *  already confirmed this is a genuine second visit that day). */
  confirmDuplicate: z.boolean().optional(),
});
export type CreateContractorSessionInput = z.infer<typeof CreateContractorSessionSchema>;

/** Bulk-import sessions (admin CSV). Each row carries a roster-resolved workerId. */
export const ImportSessionRowSchema = z.object({
  workerId: uuid(),
  sessionDate: IsoDateSchema,
  sessionType: z.string().max(100).nullable().optional(),
  units: z.number().int().min(1).max(1000),
  childInitials: z.string().max(12).nullable().optional(),
  eiid: z.string().max(40).nullable().optional(),
  caseRef: z.string().max(100).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export const ImportSessionsSchema = z.object({
  clientId: uuid(),
  rows: z.array(ImportSessionRowSchema).min(1).max(2000),
});
export type ImportSessionsInput = z.infer<typeof ImportSessionsSchema>;

/** Approve / reject / reset a set of sessions. Only approved sessions bill. */
export const SetSessionApprovalSchema = z.object({
  clientId: uuid(),
  ids: z.array(uuid()).min(1),
  status: z.enum(['approved', 'rejected', 'pending']),
});
export type SetSessionApprovalInput = z.infer<typeof SetSessionApprovalSchema>;

/** Delete a single session row. */
export const DeleteSessionSchema = z.object({
  clientId: uuid(),
  id: uuid(),
});
export type DeleteSessionInput = z.infer<typeof DeleteSessionSchema>;
