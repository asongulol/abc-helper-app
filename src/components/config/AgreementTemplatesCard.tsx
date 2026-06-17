'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { useToast } from '@/components/ui';
import type { AgreementTemplateRow } from '@/db/queries/config';
import { type AgreementVars, mergeAgreement } from '@/lib/agreements/merge';
import { AGREEMENT_KINDS } from '@/lib/config/fields';
import { saveAgreementTemplate } from '@/server/actions/config';

interface AgreementTemplatesCardProps {
  templates: AgreementTemplateRow[];
  employerName: string;
}

/** A single kind's editable fields, kept in state so tab switches preserve edits. */
interface DraftState {
  title: string;
  version: string;
  body: string;
}

type AgreementKind = (typeof AGREEMENT_KINDS)[number]['kind'];

const EMPTY_DRAFT: DraftState = { title: '', version: '1.0', body: '' };

/**
 * Sample values used only to render the live preview, so the editor shows how a
 * merged contract reads instead of raw {{tokens}}. Same merge engine the printed
 * agreement uses (src/lib/agreements/merge.ts), so the preview is faithful.
 */
const PREVIEW_VARS: AgreementVars = {
  contractor_name: 'Maria Santos',
  position: 'Childcare Specialist',
  rate: '₱18,000 / period',
  monthly_rate: '36,000',
  company_name: 'ABC Kids NY',
  start_date: '2026-01-15',
  countersigner_name: 'Aaron Anderson',
  contractor_address: '123 Mabini St, Quezon City, PH',
  employment_type: 'full_time',
  hours_per_week: '40',
  schedule: '09:00–18:00 (PHT), Mon–Fri',
  today: '2026-01-15',
};

/** Live-preview pane styling — full column width, readable serif like the print page. */
const PREVIEW_STYLE = {
  width: '100%',
  maxHeight: 360,
  overflowY: 'auto',
  margin: 0,
  padding: '10px 12px',
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  fontFamily: 'Georgia, serif',
  fontSize: 13,
  lineHeight: 1.55,
} as const;

/** Tab display order (manifest 26): Non-Compete, BAA, NDA, IC Agreement. */
const TAB_ORDER: readonly AgreementKind[] = [
  'non_compete',
  'baa',
  'confidentiality_nda',
  'ic_agreement',
];

const KIND_LABEL: Record<AgreementKind, string> = Object.fromEntries(
  AGREEMENT_KINDS.map(({ kind, label }) => [kind, label]),
) as Record<AgreementKind, string>;

/**
 * Agreement templates editor (manifest 26) — rendered inside a Modal titled
 * "Agreement templates". One tab per AGREEMENT_KIND; selecting a tab edits that
 * kind's body (pre-filled from `templates`, empty if none). Per-kind drafts live
 * in state so switching tabs preserves unsaved edits. Merge fields are listed as
 * a static grouped reference, and a full-column-width live preview below the
 * editor renders the body with sample values so you can see how the merged
 * contract reads. Tabs + a single "Save template" button (Close lives in the
 * Modal header) — no Cancel.
 */
export const AgreementTemplatesCard = ({
  templates,
  employerName,
}: AgreementTemplatesCardProps) => {
  const toast = useToast();
  const router = useRouter();
  const bodyId = useId();
  const [isPending, startTransition] = useTransition();

  const [activeKind, setActiveKind] = useState<AgreementKind>('ic_agreement');
  const [drafts, setDrafts] = useState<Record<string, DraftState>>(() => {
    const seed: Record<string, DraftState> = {};
    for (const { kind } of AGREEMENT_KINDS) {
      const found = templates.find((t) => t.kind === kind);
      seed[kind] = {
        title: found?.title ?? '',
        version: found?.version ?? '1.0',
        body: found?.body ?? '',
      };
    }
    return seed;
  });

  const draft = drafts[activeKind] ?? EMPTY_DRAFT;

  const patchDraft = (patch: Partial<DraftState>) => {
    setDrafts((d) => {
      const next: DraftState = { ...(d[activeKind] ?? EMPTY_DRAFT), ...patch };
      return { ...d, [activeKind]: next };
    });
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await saveAgreementTemplate({
          kind: activeKind,
          title: draft.title,
          body: draft.body,
          version: draft.version || '1.0',
        });
        if (res.ok) {
          toast.notify('Template saved.', { type: 'success' });
          // Refetch server data so reopening the modal reflects the saved template
          // (drafts are seeded once from the `templates` prop on mount).
          router.refresh();
        } else {
          toast.notify(res.error, { type: 'error' });
        }
      } catch (e) {
        toast.notify(e instanceof Error ? e.message : 'Failed to save template.', {
          type: 'error',
        });
      }
    });
  };

  return (
    <div>
      <p className="sub">
        Paste the standard agreement text. Merge fields (filled per contractor when prepared):
        <br />
        <b>Parties:</b> <code>{'{{employer_name}}'}</code> = the contracting employer (
        {employerName}) · <code>{'{{client_name}}'}</code> (a.k.a. <code>{'{{company_name}}'}</code>
        ) = the assigned client company · <code>{'{{contractor_name}}'}</code> ·{' '}
        <code>{'{{countersigner_name}}'}</code>
        <br />
        <b>Engagement:</b> <code>{'{{position}}'}</code> · <code>{'{{rate}}'}</code> (per period) ·{' '}
        <code>{'{{monthly_rate}}'}</code> · <code>{'{{start_date}}'}</code> ·{' '}
        <code>{'{{contractor_address}}'}</code> · <code>{'{{employment_type}}'}</code> (e.g.
        “Full-time (40 hours/week)”) · <code>{'{{hours_per_week}}'}</code> ·{' '}
        <code>{'{{schedule}}'}</code> (shift) · <code>{'{{today}}'}</code> ·{' '}
        <code>{'{{addendum}}'}</code>
        <br />
        <span className="muted" style={{ fontSize: 12 }}>
          If you don’t place <code>{'{{employment_type}}'}</code>/<code>{'{{schedule}}'}</code> in
          the text, an “Engagement: … Work schedule: …” line is appended automatically.
        </span>
      </p>

      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {TAB_ORDER.map((kind) => (
          <button
            key={kind}
            type="button"
            className={kind === activeKind ? 'btn sm' : 'btn ghost sm'}
            onClick={() => setActiveKind(kind)}
          >
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor={bodyId}>Body</label>
        <textarea
          id={bodyId}
          rows={16}
          value={draft.body}
          onChange={(e) => patchDraft({ body: e.target.value })}
          placeholder="Agreement body…"
          disabled={isPending}
        />
      </div>

      <div className="field">
        <div
          style={{
            display: 'block',
            fontSize: 11,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            marginBottom: 4,
          }}
        >
          Live preview — merge fields filled with sample values
        </div>
        <pre style={PREVIEW_STYLE}>
          {draft.body.trim()
            ? mergeAgreement(draft.body, { ...PREVIEW_VARS, employer_name: employerName })
            : 'Nothing to preview yet — paste the agreement text above.'}
        </pre>
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </div>
  );
};
