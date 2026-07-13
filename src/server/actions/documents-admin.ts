'use server';

/**
 * Documents admin server actions — add_document (ports legacy Documents tab).
 *
 * Legacy reference (app/index.html ~7338-7440): the Documents tab tracks each
 * contractor's IC agreement, W-8BEN, and IDs with optional signed/expiry dates.
 * The inline "Add document" row inserts a `documents` row; an empty title falls
 * back to the selected type's label (e.g. "IC Agreement").
 *
 * Pattern: verify admin → company scope check → port legacy insert → audit log.
 */

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/db/clients/server';
import type { Database } from '@/db/types';
import { humanizeError } from '@/lib/errors';
import type { ActionResult } from '@/server/actions/portal-admin';
import { logEvent } from '@/server/audit';
import { getCurrentAdmin } from '@/server/auth/admin';

type DocumentKind = Database['public']['Enums']['document_kind'];

/** Type options shown in the add-document row — verbatim from legacy DOC_KINDS. */
const DOC_KINDS: ReadonlyArray<readonly [DocumentKind, string]> = [
  ['ic_agreement', 'IC Agreement'],
  ['w8ben', 'W-8BEN'],
  ['gov_id', 'Gov ID'],
  ['other', 'Other'],
];

export interface AddDocumentInput {
  companyId: string;
  workerId: string;
  kind: DocumentKind;
  title: string;
  signedOn: string;
  expiresOn: string;
}

/** Add a tracked document for a contractor (ports legacy addDoc). */
export async function addDocument(input: AddDocumentInput): Promise<ActionResult> {
  const admin = await getCurrentAdmin();
  if (!admin) return { ok: false, error: 'Not signed in as an admin.' };

  if (!input.workerId) return { ok: false, error: 'Pick a contractor.' };

  if (!admin.isOwner && !admin.companyIds.includes(input.companyId)) {
    return { ok: false, error: 'No access to this company.' };
  }

  const label = DOC_KINDS.find((k) => k[0] === input.kind)?.[1] ?? input.kind;

  try {
    const db = await createServerSupabase();
    const { error } = await db.from('documents').insert({
      worker_id: input.workerId,
      company_id: input.companyId || null,
      kind: input.kind,
      title: input.title || label,
      signed_on: input.signedOn || null,
      expires_on: input.expiresOn || null,
    });
    if (error) return { ok: false, error: error.message };

    await logEvent({
      companyId: input.companyId,
      action: 'add_document',
      entity: input.title || label,
      detail: { kind: input.kind, worker_id: input.workerId },
    });

    revalidatePath('/documents');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: humanizeError(err, 'Add failed.'),
    };
  }
}
