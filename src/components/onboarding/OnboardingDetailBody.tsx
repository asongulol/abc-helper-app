'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { DocReviewModal } from '@/components/documents/DocReviewModal';
import { Badge, type BadgeTone, ConfirmDangerModal, Modal, useToast } from '@/components/ui';
import type { OnboardingProgressRow } from '@/db/queries/onboarding';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { DocSlotState, DocSlotStatus } from '@/lib/onboarding/documents';
import { deriveStageInfo } from '@/lib/onboarding/progress';
import {
  editAgreementDate,
  editAgreementPrefill,
  getOnboardingDetail,
  markOnboardingComplete,
  type OnbAgreementLite,
  type OnbDocLite,
  type OnbProfileLite,
  type OnbSignatureLite,
  resetOnboarding,
  setOnboardingStage,
} from '@/server/actions/onboarding';
import {
  clearMissingDocumentResolution,
  countersignAgreement,
  resolveMissingDocument,
  reviewDocument,
} from '@/server/actions/portal';
import {
  deleteContractor,
  resendHireEmails,
  resetPortalPassword,
  withdrawOffer,
} from '@/server/actions/portal-admin';
import { uploadDocumentForContractor } from '@/server/actions/portal-docs';

interface Props {
  row: OnboardingProgressRow;
  canCountersign: boolean;
  isOwner: boolean;
  onClose: () => void;
}

const AGREEMENT_LABELS: Record<string, string> = {
  ic_agreement: 'IC Agreement',
  non_compete: 'Non-Compete',
  confidentiality_nda: 'Confidentiality NDA',
  baa: 'BAA',
};

/** Human-readable label for each required-document slot state. */
const DOC_STATE_LABEL: Record<DocSlotState, string> = {
  missing: 'Not uploaded',
  pending: 'Pending review',
  approved: 'Approved',
  needs_replacement: 'Needs replacement',
  waived: 'Waived',
  deferred: 'Deferred',
};

/** Badge tone per slot state — red flags what still blocks completion. */
const docStateTone = (s: DocSlotState): BadgeTone =>
  s === 'approved' || s === 'waived'
    ? 'good'
    : s === 'missing' || s === 'needs_replacement'
      ? 'bad'
      : 'neutral';

/**
 * The onboarding review content — presentation-agnostic so it renders inside
 * either the overlay modal (`OnboardingDrilldown`, mounted by the intercept
 * route) or the full page (`OnboardingDetailPage`, hard navigation). The outer
 * chrome (modal vs. page card + title) lives in those shells; `onClose` returns
 * to the list after a destructive action (delete / withdraw).
 */
export const OnboardingDetailBody = ({ row, canCountersign, isOwner, onClose }: Props) => {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [countersignModal, setCountersignModal] = useState<string | null>(null);
  const [signatureInput, setSignatureInput] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState<string | null>(null);
  const [resend, setResend] = useState<{
    email: string;
    busy: boolean;
    err: string;
    done: { changed: boolean; email: string; password: string } | null;
  } | null>(null);
  const [prefillEdit, setPrefillEdit] = useState<{
    kind: string;
    position: string;
    rate: string;
    startDate: string;
  } | null>(null);
  // Inline modals replacing the old window.prompt() calls.
  const [editDate, setEditDate] = useState<{
    kind: string;
    value: string;
  } | null>(null);
  const [reason, setReason] = useState<{
    documentId: string;
    text: string;
  } | null>(null);
  // Pending waive awaiting confirmation (both uploaded + missing-doc paths).
  const [waiveConfirm, setWaiveConfirm] = useState<{
    label: string;
    run: () => void;
  } | null>(null);
  // Document under review — DocReviewModal shows the preview + decisions.
  const [reviewDoc, setReviewDoc] = useState<OnbDocLite | null>(null);

  const runStage = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        notify(msg, { type: 'success' });
        router.refresh();
      } else {
        notify(res.error ?? 'Failed.', { type: 'error' });
      }
    });
  };

  const submitEditDate = () => {
    if (!editDate) return;
    const { kind, value } = editDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      notify('Enter a date (YYYY-MM-DD).', { type: 'error' });
      return;
    }
    runStage(
      () =>
        editAgreementDate({
          workerId: row.workerId,
          agreementKind: kind as Parameters<typeof editAgreementDate>[0]['agreementKind'],
          signedDate: value,
        }).then((r) => {
          if (r.ok) {
            loadDetail();
            setEditDate(null);
          }
          return r;
        }),
      'Signed date updated.',
    );
  };

  const handleSavePrefill = () => {
    if (!prefillEdit) return;
    const p = prefillEdit;
    startTransition(async () => {
      const res = await editAgreementPrefill({
        workerId: row.workerId,
        agreementKind: p.kind as Parameters<typeof editAgreementPrefill>[0]['agreementKind'],
        position: p.position,
        rate: p.rate,
        startDate: p.startDate,
      });
      if (res.ok) {
        notify('Prefill updated.', { type: 'success' });
        setPrefillEdit(null);
        router.refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };
  const [signatures, setSignatures] = useState<OnbSignatureLite[]>([]);
  const [agreements, setAgreements] = useState<OnbAgreementLite[]>([]);
  const [documents, setDocuments] = useState<OnbDocLite[]>([]);
  const [docChecklist, setDocChecklist] = useState<DocSlotStatus[]>([]);
  const [profile, setProfile] = useState<OnbProfileLite | null>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);
  // Which missing-doc slot has its inline "defer until" date picker open.
  const [deferSlotKey, setDeferSlotKey] = useState<string | null>(null);
  const [deferDate, setDeferDate] = useState('');
  // Which checklist slot has its inline admin-upload row open.
  const [uploadSlot, setUploadSlot] = useState<{
    key: string;
    file: File | null;
    issuedOn: string;
  } | null>(null);

  const loadDetail = () => {
    getOnboardingDetail(row.workerId).then((res) => {
      if (res.ok) {
        setSignatures(res.data.signatures);
        setAgreements(res.data.agreements);
        setDocuments(res.data.documents);
        setDocChecklist(res.data.documentChecklist);
        setProfile(res.data.profile);
        setLoginEmail(res.data.loginEmail);
      }
      setDetailLoaded(true);
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per worker on open.
  useEffect(() => {
    loadDetail();
  }, [row.workerId]);

  // Admin uploads a file into a checklist slot on the contractor's behalf.
  const handleUploadFor = (slot: DocSlotStatus) => {
    if (!uploadSlot?.file) return;
    const form = new FormData();
    form.set('workerId', row.workerId);
    form.set('file', uploadSlot.file);
    form.set('kind', slot.kind);
    if (slot.side) form.set('side', slot.side);
    if (slot.kind === 'nbi_clearance') form.set('issuedOn', uploadSlot.issuedOn);
    startTransition(async () => {
      const res = await uploadDocumentForContractor(form);
      if (res.ok) {
        notify('Uploaded — pending review.', { type: 'success' });
        setUploadSlot(null);
        loadDetail();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const handleReview = (
    documentId: string,
    decision: 'approve' | 'needs_replacement' | 'waive' | 'defer',
  ) => {
    // Needs-replacement requires a contractor-facing reason — collect it in a
    // proper modal (submitReplacement) rather than a bare window.prompt.
    if (decision === 'needs_replacement') {
      setReason({ documentId, text: '' });
      return;
    }
    startTransition(async () => {
      const res = await reviewDocument({ documentId, decision });
      if (res.ok) {
        notify('Document updated.', { type: 'success' });
        loadDetail();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const submitReplacement = () => {
    if (!reason) return;
    const { documentId, text } = reason;
    const note = text.trim();
    if (!note) return;
    startTransition(async () => {
      const res = await reviewDocument({
        documentId,
        decision: 'needs_replacement',
        note,
      });
      if (res.ok) {
        notify('Replacement requested.', { type: 'success' });
        setReason(null);
        loadDetail();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const slotKey = (slot: DocSlotStatus) => `${slot.kind}|${slot.side ?? ''}`;

  // Waive / defer a required doc the contractor hasn't uploaded yet.
  const handleResolveMissing = (
    slot: DocSlotStatus,
    decision: 'waive' | 'defer',
    deferUntil?: string,
  ) => {
    startTransition(async () => {
      const res = await resolveMissingDocument({
        workerId: row.workerId,
        kind: slot.kind,
        side: slot.side,
        decision,
        ...(deferUntil ? { deferUntil } : {}),
      });
      if (res.ok) {
        notify(
          decision === 'waive'
            ? 'Document waived.'
            : `Deferred until ${fmtDate(deferUntil ?? '')}.`,
          { type: 'success' },
        );
        setDeferSlotKey(null);
        setDeferDate('');
        loadDetail();
        router.refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  // Nudge the contractor to finish their outstanding documents.
  const handleRemind = () => {
    startTransition(async () => {
      const res = await resendHireEmails({ workerId: row.workerId });
      if (res.ok) notify('Reminder email queued.', { type: 'success' });
      else notify(res.error, { type: 'error' });
    });
  };

  // Revert a waive/defer so the slot reads MISSING again.
  const handleClearResolution = (slot: DocSlotStatus) => {
    startTransition(async () => {
      const res = await clearMissingDocumentResolution({
        workerId: row.workerId,
        kind: slot.kind,
        side: slot.side,
      });
      if (res.ok) {
        notify('Reverted — document is required again.', { type: 'success' });
        loadDetail();
        router.refresh();
      } else {
        notify(res.error, { type: 'error' });
      }
    });
  };

  const docStatusTone = (s: OnbDocLite['reviewStatus']) =>
    s === 'approved' ? 'good' : s === 'needs_replacement' ? 'bad' : 'neutral';

  const fileName = (d: OnbDocLite) =>
    (d.storagePath ? (d.storagePath.split('/').pop() ?? d.storagePath) : null) ??
    d.title ??
    AGREEMENT_LABELS[d.kind] ??
    d.kind;

  const submitResend = () => {
    if (!resend) return;
    const email = resend.email.trim();
    if (!email) return;
    setResend((r) => (r ? { ...r, busy: true, err: '' } : r));
    startTransition(async () => {
      const res = await resetPortalPassword({ workerId: row.workerId, email });
      if (res.ok) {
        setResend((r) =>
          r
            ? {
                ...r,
                busy: false,
                done: {
                  changed: res.data?.changed ?? false,
                  email: res.data?.email ?? email,
                  password: res.data?.tempPassword ?? '',
                },
              }
            : r,
        );
        router.refresh();
      } else {
        setResend((r) => (r ? { ...r, busy: false, err: res.error } : r));
      }
    });
  };

  const info = deriveStageInfo({
    stage1Complete: row.stage1Complete,
    stage2Complete: row.stage2Complete,
    stage3Complete: row.stage3Complete,
    completedAt: row.completedAt,
    currentStage: row.currentStage,
    nameMismatchFlag: row.nameMismatchFlag,
    stalled: row.stalled,
  });

  const handleCountersign = (agreementKey: string) => {
    if (!signatureInput.trim()) {
      notify('Signature required.', { type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await countersignAgreement({
        workerId: row.workerId,
        agreementKey,
        signatureDataUrl: signatureInput.trim(),
      });
      if (result.ok) {
        notify('Agreement countersigned.', { type: 'success' });
        setCountersignModal(null);
        setSignatureInput('');
      } else {
        notify(result.error, { type: 'error' });
      }
    });
  };

  const agreementKinds = ['ic_agreement', 'non_compete', 'confidentiality_nda', 'baa'] as const;

  // Documents: resolve the required checklist against uploads so MISSING docs
  // are shown (not just uploaded ones). Uploads not matching a required slot
  // (e.g. 'other', 'w8ben') are listed separately so they're still reviewable.
  const docsById = new Map(documents.map((d) => [d.id, d]));
  const slotDocIds = new Set(
    docChecklist.map((s) => s.documentId).filter((id): id is string => id !== null),
  );
  const extraDocs = documents.filter((d) => !slotDocIds.has(d.id));
  const missingDocCount = docChecklist.filter((s) => s.state === 'missing').length;

  const docRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '6px 0',
    borderBottom: '1px solid var(--border)',
  } as const;

  // One button per row — the preview + review decisions live in DocReviewModal.
  const renderDocActions = (d: OnbDocLite) => (
    <button
      type="button"
      className="btn ghost sm"
      disabled={isPending}
      onClick={() => setReviewDoc(d)}
    >
      Review
    </button>
  );

  // Actions for a required doc with no upload: waive, or defer up to a date.
  // `placeholder` is the fileless waived/deferred row when one already exists.
  const renderOverrideActions = (slot: DocSlotStatus, placeholder: OnbDocLite | null) => {
    const key = slotKey(slot);
    if (deferSlotKey === key) {
      return (
        <div
          style={{
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span className="muted" style={{ fontSize: 12 }}>
            Defer until
          </span>
          <input
            type="date"
            value={deferDate}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDeferDate(e.target.value)}
            style={{ fontSize: 12 }}
            aria-label="Defer until"
          />
          <button
            type="button"
            className="btn sm"
            disabled={isPending || !deferDate}
            onClick={() => handleResolveMissing(slot, 'defer', deferDate)}
          >
            Confirm
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setDeferSlotKey(null);
              setDeferDate('');
            }}
          >
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn ghost sm"
          disabled={isPending}
          onClick={() =>
            setWaiveConfirm({
              label: slot.label,
              run: () => handleResolveMissing(slot, 'waive'),
            })
          }
        >
          Waive
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={isPending}
          onClick={() => {
            setDeferSlotKey(key);
            if (slot.state === 'deferred' && placeholder?.expiresOn) {
              // Re-deferring an already-deferred slot — pre-fill the existing due date.
              setDeferDate(placeholder.expiresOn);
            } else {
              // Default to ~2 weeks out so Confirm is immediately actionable.
              const d = new Date();
              d.setDate(d.getDate() + 14);
              setDeferDate(d.toISOString().slice(0, 10));
            }
          }}
        >
          {slot.state === 'deferred' ? 'Change date' : 'Defer…'}
        </button>
        {placeholder && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={isPending}
            onClick={() => handleClearResolution(slot)}
          >
            Undo
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Badge tone={info.tone}>{info.label}</Badge>
        {row.nameMismatchFlag && (
          <Badge tone="warn" style={{ marginLeft: 6 }}>
            Name mismatch
          </Badge>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <p className="sub" style={{ marginBottom: 4 }}>
          Started: {fmtDate(row.startedAt)}
          {row.completedAt && ` · Completed: ${fmtDateTime(row.completedAt)}`}
        </p>
      </div>

      {/* Stage override chips */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        <button
          type="button"
          className="btn ghost sm"
          disabled={isPending}
          onClick={() =>
            runStage(() => markOnboardingComplete({ workerId: row.workerId }), 'Marked complete.')
          }
        >
          ✓ Mark complete
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={isPending}
          onClick={() =>
            runStage(() => resetOnboarding({ workerId: row.workerId }), 'Onboarding reset.')
          }
        >
          ↺ Reset
        </button>
        {([1, 2, 3] as const).map((n) => (
          <button
            key={n}
            type="button"
            className="btn ghost sm"
            disabled={isPending}
            onClick={() =>
              runStage(
                () =>
                  setOnboardingStage({
                    workerId: row.workerId,
                    stage: n,
                    complete: false,
                  }),
                `Stage ${n} reopened.`,
              )
            }
          >
            ↺ Stage {n}
          </button>
        ))}
      </div>

      {/* Countersign section */}
      {canCountersign && row.stage1Complete && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Countersign agreements</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {agreementKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn sm"
                disabled={isPending}
                onClick={() => {
                  setCountersignModal(kind);
                  setSignatureInput('');
                }}
              >
                {AGREEMENT_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 1 · Agreements summary (signed ledger) */}
      {signatures.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>1 · Agreements</h3>
          <div className="table-scroll">
            <table aria-label="Signed agreements">
              <thead>
                <tr>
                  <th scope="col">Agreement</th>
                  <th scope="col">Signed name</th>
                  <th scope="col">When</th>
                  <th scope="col">IP</th>
                  <th scope="col">Ver</th>
                </tr>
              </thead>
              <tbody>
                {signatures.map((s) => (
                  <tr key={`${s.agreementKind}-${s.signedAt}`}>
                    <td>{AGREEMENT_LABELS[s.agreementKind] ?? s.agreementKind}</td>
                    <td>{s.signedLegalName}</td>
                    <td>{fmtDateTime(s.signedAt)}</td>
                    <td>{s.ipAddress || '—'}</td>
                    <td>{s.docVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 1 · Agreements — per-agreement countersign + prefill */}
      {detailLoaded && agreements.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {agreements.map((a) => (
            <div
              key={a.agreementKind}
              style={{
                padding: '6px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <strong style={{ fontSize: 13 }}>
                  {AGREEMENT_LABELS[a.agreementKind] ?? a.agreementKind}
                </strong>
                <Badge tone="good">Signed</Badge>
                <Badge tone={a.countersignedAt ? 'good' : 'neutral'}>
                  {a.countersignedAt ? 'Countersigned' : 'Awaiting countersign'}
                </Badge>
              </div>
              {(a.fPosition || a.fRate || a.fStartDate || a.countersignedName) && (
                <div className="sub" style={{ fontSize: 12 }}>
                  {[
                    a.fPosition,
                    a.fRate,
                    a.fStartDate ? `start ${a.fStartDate}` : null,
                    a.countersignedName ? `countersigner ${a.countersignedName}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  marginTop: 6,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={isPending}
                  onClick={() =>
                    setEditDate({
                      kind: a.agreementKind,
                      value: a.fStartDate ?? '',
                    })
                  }
                >
                  Edit date
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={isPending}
                  onClick={() =>
                    setPrefillEdit({
                      kind: a.agreementKind,
                      position: a.fPosition ?? '',
                      rate: a.fRate ?? '',
                      startDate: a.fStartDate ?? '',
                    })
                  }
                >
                  Edit prefill
                </button>
                <Link
                  href={`/onboarding/${row.workerId}/${a.agreementKind}/print`}
                  target="_blank"
                  className="btn ghost sm"
                >
                  Print
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 2 · Profile */}
      {detailLoaded && profile && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>2 · Profile</h3>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: '6px 14px',
              margin: 0,
            }}
          >
            {(
              [
                ['Mobile', profile.mobile],
                ['Current address', profile.phAddress],
                ['Permanent address', profile.permanentAddress],
                ['Postal', profile.postalCode],
                ['Date of birth', profile.dateOfBirth],
                ['Emergency contact', profile.emergencyName],
                ['Relationship', profile.emergencyRelationship],
                ['Emergency mobile', profile.emergencyMobile],
                ['Marital', profile.maritalStatus],
                ['Highest Degree Attained', profile.educationLevel],
                ['Degree and Major', profile.course],
                ['Year grad.', profile.yearGraduated],
                ['School', profile.school],
                ['GCash', profile.gcash],
                ['PayMaya', profile.paymaya],
                ['PayPal', profile.paypal],
                ['Wise Tag', profile.wiseTag],
              ] as [string, string | null][]
            ).map(([label, val]) => (
              <div key={label}>
                <dt className="sub" style={{ fontSize: 11 }}>
                  {label}
                </dt>
                <dd style={{ margin: 0, fontWeight: 500 }}>{val || '—'}</dd>
              </div>
            ))}
          </dl>
          {(() => {
            const ex = profile.extras;
            const facts = (
              [
                ['Nickname', 'nickname'],
                ['Color', 'favorite_color'],
                ['Food', 'favorite_food'],
                ['T-shirt', 'tshirt_size'],
                ['Shoe', 'shoe_size'],
                ['Hobbies', 'hobbies'],
                ['Motto', 'motto'],
              ] as [string, string][]
            )
              .map(([lbl, k]) => {
                const v = ex[k];
                return v ? `${lbl}: ${String(v)}` : null;
              })
              .filter(Boolean);
            return facts.length ? (
              <p className="sub" style={{ marginTop: 8, fontSize: 12 }}>
                {facts.join(' · ')}
              </p>
            ) : null;
          })()}
        </div>
      )}

      {/* 3 · Documents review — required checklist (incl. MISSING) + extras */}
      {detailLoaded && (docChecklist.length > 0 || documents.length > 0) && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-head">
            <h3 style={{ fontSize: 14, margin: 0 }}>
              3 · Documents{' '}
              {missingDocCount > 0 && (
                <span className="pill bad" style={{ fontSize: 11, marginLeft: 4 }}>
                  {missingDocCount} missing
                </span>
              )}
            </h3>
            {missingDocCount > 0 && (
              <button
                type="button"
                className="btn ghost sm"
                disabled={isPending}
                onClick={handleRemind}
              >
                Remind contractor
              </button>
            )}
          </div>

          {docChecklist.map((slot) => {
            const doc = slot.documentId ? docsById.get(slot.documentId) : undefined;
            return (
              <div key={`${slot.kind}|${slot.side ?? ''}`} style={docRowStyle}>
                <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
                  {slot.label}
                  {slot.state === 'missing' && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {' '}
                      · awaiting contractor upload
                    </span>
                  )}
                </span>
                <Badge tone={docStateTone(slot.state)}>
                  {DOC_STATE_LABEL[slot.state]}
                  {slot.state === 'deferred' && doc?.expiresOn
                    ? ` → ${fmtDate(doc.expiresOn)}`
                    : ''}
                </Badge>
                {doc?.storagePath
                  ? renderDocActions(doc)
                  : renderOverrideActions(slot, doc ?? null)}
                {/* Upload is available on every row — additive; a new upload
                    becomes the slot's latest (pending) while history remains. */}
                {uploadSlot?.key === slotKey(slot) ? (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      onChange={(e) =>
                        setUploadSlot({
                          key: slotKey(slot),
                          file: e.target.files?.[0] ?? null,
                          issuedOn: uploadSlot.issuedOn,
                        })
                      }
                      style={{ fontSize: 12, maxWidth: 220 }}
                      aria-label={`Upload ${slot.label}`}
                    />
                    {slot.kind === 'nbi_clearance' && (
                      <input
                        type="date"
                        value={uploadSlot.issuedOn}
                        onChange={(e) => setUploadSlot({ ...uploadSlot, issuedOn: e.target.value })}
                        style={{ fontSize: 12 }}
                        aria-label="Date issued"
                      />
                    )}
                    <button
                      type="button"
                      className="btn sm"
                      disabled={
                        isPending ||
                        !uploadSlot.file ||
                        (slot.kind === 'nbi_clearance' && !uploadSlot.issuedOn)
                      }
                      onClick={() => handleUploadFor(slot)}
                    >
                      {isPending ? 'Uploading…' : 'Upload'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setUploadSlot(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={isPending}
                    onClick={() => setUploadSlot({ key: slotKey(slot), file: null, issuedOn: '' })}
                    title="Upload this document on the contractor's behalf"
                  >
                    Upload…
                  </button>
                )}
              </div>
            );
          })}

          {extraDocs.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, margin: '10px 0 2px' }}>
                Other uploads
              </div>
              {extraDocs.map((d) => (
                <div key={d.id} style={docRowStyle}>
                  <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
                    {fileName(d)}
                    {d.side ? ` (${d.side})` : ''}
                  </span>
                  <Badge tone={docStatusTone(d.reviewStatus)}>{d.reviewStatus}</Badge>
                  {renderDocActions(d)}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {resend && (
        <Modal
          title="Update login & resend"
          onClose={() => {
            if (!resend.busy) setResend(null);
          }}
          maxWidth={480}
        >
          {!resend.done ? (
            <div>
              <p className="sub">
                Confirm (or fix) the contractor&apos;s email — we&apos;ll update their portal login,
                issue a fresh temporary password, and re-send the welcome with the latest details.
              </p>
              <div className="field">
                <label htmlFor="resend-email">Login email</label>
                <input
                  id="resend-email"
                  type="email"
                  value={resend.email}
                  onChange={(e) => setResend((r) => (r ? { ...r, email: e.target.value } : r))}
                  style={{ width: '100%' }}
                  aria-label="Login email"
                />
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                A new temp password is always issued (the old one may have reached the wrong inbox).
                Fix name / company / rate / contract first via <b>Edit details</b> — those changes
                are included in the email.
              </p>
              {resend.err && (
                <div className="err" style={{ fontSize: 13, marginTop: 6 }}>
                  {resend.err}
                </div>
              )}
              <div className="actions" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={resend.busy}
                  onClick={() => setResend(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={resend.busy || !resend.email.trim()}
                  onClick={submitResend}
                >
                  {resend.busy ? 'Sending…' : 'Update & resend'}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div
                className="banner"
                style={{ background: 'var(--good-soft)', borderColor: '#86efac' }}
              >
                ✓{' '}
                {resend.done.changed
                  ? 'Login email updated and welcome re-sent.'
                  : 'Welcome re-sent with a fresh password.'}
              </div>
              <div className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="row">
                  <span className="muted">Email</span>
                  <b>{resend.done.email}</b>
                </div>
                <div className="row">
                  <span className="muted">New temp password</span>
                  <b>{resend.done.password}</b>
                </div>
              </div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(
                        `Email: ${resend.done?.email}\nTemp password: ${resend.done?.password}`,
                      );
                    } catch {
                      /* clipboard unavailable */
                    }
                  }}
                >
                  Copy
                </button>
                <button type="button" className="btn" onClick={() => setResend(null)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn ghost sm"
            disabled={isPending}
            onClick={() =>
              setResend({
                email: loginEmail ?? '',
                busy: false,
                err: '',
                done: null,
              })
            }
          >
            ✉ Update login &amp; resend
          </button>
          <button
            type="button"
            className="btn ghost sm"
            style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
            disabled={isPending}
            onClick={() => setWithdrawOpen(true)}
          >
            Withdraw offer…
          </button>
          {isOwner && (
            <button
              type="button"
              className="btn ghost sm"
              style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}
              disabled={isPending}
              onClick={() => setDeleteOpen(true)}
            >
              Delete hire…
            </button>
          )}
        </div>
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {countersignModal !== null && (
        <Modal
          title={`Countersign — ${AGREEMENT_LABELS[countersignModal] ?? countersignModal}`}
          onClose={() => setCountersignModal(null)}
          maxWidth={400}
        >
          <p className="sub" style={{ marginBottom: 10 }}>
            Enter your full legal name or paste a drawn-signature data URL.
          </p>
          <textarea
            value={signatureInput}
            onChange={(e) => setSignatureInput(e.target.value)}
            rows={3}
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="Full legal name or data:image/... URI"
            aria-label="Countersignature"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => handleCountersign(countersignModal)}
            >
              {isPending ? 'Signing…' : 'Countersign'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setCountersignModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {reviewDoc && (
        <DocReviewModal
          documentId={reviewDoc.id}
          name={fileName(reviewDoc)}
          storagePath={reviewDoc.storagePath}
          busy={isPending}
          onDecision={(decision) => {
            const d = reviewDoc;
            setReviewDoc(null);
            if (decision === 'waive')
              setWaiveConfirm({ label: fileName(d), run: () => handleReview(d.id, 'waive') });
            // handleReview already routes needs_replacement to the reason modal.
            else handleReview(d.id, decision);
          }}
          onClose={() => setReviewDoc(null)}
        />
      )}

      {waiveConfirm && (
        <ConfirmDangerModal
          title="Waive this document?"
          message={`Waive “${waiveConfirm.label}”? The contractor won't be required to provide it, and stage 3 can complete without it.`}
          consequence="Reversible — re-decide the document (or Undo) to require it again."
          confirmLabel="Waive"
          busy={isPending}
          onConfirm={() => {
            waiveConfirm.run();
            setWaiveConfirm(null);
          }}
          onCancel={() => setWaiveConfirm(null)}
        />
      )}

      {withdrawOpen && (
        <ConfirmDangerModal
          title="Withdraw offer"
          message={`Withdraw the offer for ${row.workerName}? Their portal login is revoked and they are notified.`}
          consequence="Refused if any payroll or time exists. Cannot be undone."
          confirmWord="WITHDRAW"
          confirmLabel="Withdraw offer"
          busy={isPending}
          onConfirm={() => {
            startTransition(async () => {
              const res = await withdrawOffer({ workerId: row.workerId });
              if (!res.ok) {
                notify(res.error, { type: 'error' });
                return;
              }
              notify('Offer withdrawn.', { type: 'success' });
              setWithdrawOpen(false);
              onClose();
              router.refresh();
            });
          }}
          onCancel={() => setWithdrawOpen(false)}
        />
      )}

      {deleteOpen && (
        <ConfirmDangerModal
          title="Delete hire"
          message={`Permanently delete ${row.workerName}? This removes their portal login, onboarding, and uploaded documents.`}
          consequence="Owner-only. Blocked if any payroll or time history exists. Cannot be undone."
          confirmWord={row.workerName || 'DELETE'}
          confirmLabel="Delete hire"
          busy={isPending}
          onConfirm={() => {
            startTransition(async () => {
              const res = await deleteContractor({
                workerId: row.workerId,
                force: true,
              });
              if (!res.ok) {
                notify(res.error, { type: 'error' });
                return;
              }
              notify('Hire deleted.', { type: 'success' });
              setDeleteOpen(false);
              onClose();
              router.refresh();
            });
          }}
          onCancel={() => setDeleteOpen(false)}
        />
      )}

      {prefillEdit && (
        <Modal
          title={`Edit prefill — ${AGREEMENT_LABELS[prefillEdit.kind] ?? prefillEdit.kind}`}
          onClose={() => setPrefillEdit(null)}
          maxWidth={420}
        >
          <p className="sub" style={{ marginBottom: 10 }}>
            Leave a field blank to clear it. These values fill the prepared agreement.
          </p>
          <div className="field">
            <label htmlFor="pf-position">Position</label>
            <input
              id="pf-position"
              value={prefillEdit.position}
              onChange={(e) => setPrefillEdit({ ...prefillEdit, position: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-rate">Rate (per period)</label>
            <input
              id="pf-rate"
              value={prefillEdit.rate}
              onChange={(e) => setPrefillEdit({ ...prefillEdit, rate: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="pf-start">Start date (YYYY-MM-DD)</label>
            <input
              id="pf-start"
              value={prefillEdit.startDate}
              onChange={(e) => setPrefillEdit({ ...prefillEdit, startDate: e.target.value })}
              placeholder="2026-06-11"
            />
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setPrefillEdit(null)}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={isPending} onClick={handleSavePrefill}>
              {isPending ? 'Saving…' : 'Save prefill'}
            </button>
          </div>
        </Modal>
      )}

      {editDate && (
        <Modal
          title={`Edit signed date — ${AGREEMENT_LABELS[editDate.kind] ?? editDate.kind}`}
          onClose={() => setEditDate(null)}
          maxWidth={360}
        >
          <div className="field">
            <label htmlFor="ed-date">Signed date</label>
            <input
              id="ed-date"
              type="date"
              value={editDate.value}
              onChange={(e) => setEditDate({ ...editDate, value: e.target.value })}
            />
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setEditDate(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={isPending || !editDate.value}
              onClick={submitEditDate}
            >
              {isPending ? 'Saving…' : 'Save date'}
            </button>
          </div>
        </Modal>
      )}

      {reason && (
        <Modal title="Request replacement" onClose={() => setReason(null)} maxWidth={440}>
          <p className="sub" style={{ marginBottom: 10 }}>
            Tell the contractor what needs fixing — they will see this reason.
          </p>
          <div className="field">
            <label htmlFor="rv-reason">Reason</label>
            <textarea
              id="rv-reason"
              rows={3}
              value={reason.text}
              onChange={(e) => setReason({ ...reason, text: e.target.value })}
              placeholder="e.g. NBI clearance is expired — please upload a current one."
              style={{ width: '100%' }}
            />
          </div>
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setReason(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={isPending || !reason.text.trim()}
              onClick={submitReplacement}
            >
              {isPending ? 'Saving…' : 'Request replacement'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};
