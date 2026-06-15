'use client';

import { useToast } from '@/components/ui';
import type { OnbAgreement, OnbDocument, OnboardingConfig } from '@/db/queries/config';
import { REMINDER_FREQUENCIES, SIGNATURE_METHOD_CHOICES } from '@/lib/config/fields';
import { saveOnboardingConfig } from '@/server/actions/config';
import { DEFAULT_HIRE_EMAILS } from '@/server/email/templates';
import { useId, useState, useTransition } from 'react';

interface OnboardingConfigCardProps {
  config: OnboardingConfig;
  onClose: () => void;
}

/** Default documents new contractors upload, used by "Reset to defaults". */
const DEFAULT_DOCUMENTS: OnbDocument[] = [
  { kind: 'resume', title: 'Resume / CV', required: true },
  { kind: 'diploma', title: 'Diploma or Transcript of Records', required: true },
  { kind: 'nbi_clearance', title: 'NBI Clearance', required: true, freshness_months: 6 },
  {
    kind: 'gov_id',
    title: 'Government-issued ID or Passport',
    required: true,
    sides: ['front', 'back'],
  },
];

/** Default agreements presented for signature, used by "Reset to defaults". */
const DEFAULT_AGREEMENTS: OnbAgreement[] = [
  { kind: 'ic_agreement', order: 0, title: 'Independent Contractor Agreement', required: true },
  {
    kind: 'confidentiality_nda',
    order: 1,
    title: 'Confidentiality / Non-Disclosure Agreement / Non-Compete',
    required: true,
  },
  { kind: 'baa', order: 2, title: 'Business Associate Agreement (BAA)', required: true },
];

/**
 * Onboarding setup modal body (manifest 27) — the richest config panel.
 * Holds the entire OnboardingConfig in local state from props; a single Save
 * at the bottom persists the whole singleton via saveOnboardingConfig.
 */
export const OnboardingConfigCard = ({ config, onClose }: OnboardingConfigCardProps) => {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<OnboardingConfig>(config);
  const [rawJson, setRawJson] = useState('');
  const [rawError, setRawError] = useState('');

  const enabledId = useId();
  const sigContractorId = useId();
  const sigCountersignerId = useId();
  const autoSendId = useId();
  const portalUrlId = useId();
  const wiseUrlId = useId();
  const welcomeSubjectId = useId();
  const welcomeBodyId = useId();
  const toolsSubjectId = useId();
  const toolsBodyId = useId();
  const credsSubjectId = useId();
  const credsBodyId = useId();
  const remindersEnabledId = useId();
  const remindersDeferredId = useId();
  const remindersFreqId = useId();
  const remindersSendToId = useId();
  const rawJsonId = useId();

  // ─── Document helpers ──────────────────────────────────────────────────────
  const updateDoc = (i: number, patch: Partial<Record<keyof OnbDocument, unknown>>) => {
    setState((s) => ({
      ...s,
      documents: s.documents.map((d, idx) => {
        if (idx !== i) return d;
        const merged = { ...d } as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete merged[k];
          else merged[k] = v;
        }
        return merged as unknown as OnbDocument;
      }),
    }));
  };

  const moveDoc = (i: number, dir: -1 | 1) => {
    setState((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.documents.length) return s;
      const next = s.documents.slice();
      const a = next[i];
      const b = next[j];
      if (!a || !b) return s;
      next[i] = b;
      next[j] = a;
      return { ...s, documents: next };
    });
  };

  const removeDoc = (i: number) => {
    setState((s) => ({ ...s, documents: s.documents.filter((_, idx) => idx !== i) }));
  };

  const addDoc = () => {
    setState((s) => ({
      ...s,
      documents: [...s.documents, { kind: `doc_${s.documents.length}`, title: '', required: true }],
    }));
  };

  // ─── Agreement helpers ─────────────────────────────────────────────────────
  const updateAgreement = (i: number, patch: Partial<OnbAgreement>) => {
    setState((s) => ({
      ...s,
      agreements: s.agreements.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    }));
  };

  const moveAgreement = (i: number, dir: -1 | 1) => {
    setState((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.agreements.length) return s;
      const next = s.agreements.slice();
      const a = next[i];
      const b = next[j];
      if (!a || !b) return s;
      next[i] = b;
      next[j] = a;
      return { ...s, agreements: next.map((ag, idx) => ({ ...ag, order: idx })) };
    });
  };

  const removeAgreement = (i: number) => {
    setState((s) => ({
      ...s,
      agreements: s.agreements
        .filter((_, idx) => idx !== i)
        .map((a, idx) => ({ ...a, order: idx })),
    }));
  };

  const addAgreement = () => {
    setState((s) => ({
      ...s,
      agreements: [
        ...s.agreements,
        {
          kind: `agreement_${s.agreements.length}`,
          order: s.agreements.length,
          title: '',
          required: true,
        },
      ],
    }));
  };

  // ─── Reset helpers ─────────────────────────────────────────────────────────
  const resetDocsAndAgreements = () => {
    setState((s) => ({
      ...s,
      documents: DEFAULT_DOCUMENTS.map((d) => ({ ...d })),
      agreements: DEFAULT_AGREEMENTS.map((a) => ({ ...a })),
    }));
  };

  const resetEmailWording = () => {
    setState((s) => ({
      ...s,
      emails: {
        ...s.emails,
        auto_send: DEFAULT_HIRE_EMAILS.auto_send,
        portal_url: DEFAULT_HIRE_EMAILS.portal_url,
        wise_referral_url: DEFAULT_HIRE_EMAILS.wise_referral_url,
        welcome: { ...DEFAULT_HIRE_EMAILS.welcome },
        tools: { ...DEFAULT_HIRE_EMAILS.tools },
        credentials: { ...DEFAULT_HIRE_EMAILS.credentials },
      },
    }));
  };

  // ─── Raw JSON helpers ──────────────────────────────────────────────────────
  const handleRawJsonChange = (value: string) => {
    setRawJson(value);
    try {
      const parsed = JSON.parse(value) as OnboardingConfig;
      setState(parsed);
      setRawError('');
    } catch (e) {
      setRawError(e instanceof Error ? e.message : 'Invalid JSON.');
    }
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        const res = await saveOnboardingConfig({ config: state });
        if (res.ok) {
          notify('Onboarding setup saved.', { type: 'success' });
          onClose();
        } else {
          notify(res.error, { type: 'error' });
        }
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Failed to save onboarding setup.', {
          type: 'error',
        });
      }
    });
  };

  return (
    <div>
      {/* ─── Onboarding enabled ─── */}
      <div className="field">
        <label htmlFor={enabledId}>
          <input
            id={enabledId}
            type="checkbox"
            checked={state.onboarding_enabled}
            onChange={(e) => setState((s) => ({ ...s, onboarding_enabled: e.target.checked }))}
          />{' '}
          Onboarding enabled — when on, new (non-grandfathered) contractors must complete onboarding
          at login.
        </label>
      </div>

      {/* ─── Documents ─── */}
      <h3>
        📄 Documents to collect <span className="badge">{state.documents.length} items</span>
      </h3>
      <p className="sub">
        What new contractors upload. Required ones must be approved before onboarding completes.
      </p>
      {state.documents.length === 0 ? (
        <p className="muted">No documents configured.</p>
      ) : (
        state.documents.map((doc, i) => (
          <div className="row" key={doc.kind}>
            <div className="field" style={{ minWidth: 220 }}>
              <input
                type="text"
                value={doc.title}
                onChange={(e) => updateDoc(i, { title: e.target.value })}
                placeholder="Document name (e.g. NBI Clearance)"
              />
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={doc.required}
                  onChange={(e) => updateDoc(i, { required: e.target.checked })}
                />{' '}
                Required
              </label>
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={Array.isArray(doc.sides)}
                  onChange={(e) =>
                    updateDoc(i, { sides: e.target.checked ? ['front', 'back'] : undefined })
                  }
                />{' '}
                Front &amp; back
              </label>
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>
                Expires after{' '}
                <input
                  type="number"
                  value={doc.freshness_months ?? ''}
                  onChange={(e) =>
                    updateDoc(i, {
                      freshness_months: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                  placeholder="—"
                  style={{ width: 64 }}
                />{' '}
                months
              </label>
            </div>
            <span className="badge">id: {doc.kind}</span>
            <div className="actions">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => moveDoc(i, -1)}
                disabled={i === 0}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => moveDoc(i, 1)}
                disabled={i === state.documents.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => removeDoc(i)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
        ))
      )}
      <div className="actions">
        <button type="button" className="btn ghost sm" onClick={addDoc}>
          + Add document
        </button>
        <button type="button" className="btn ghost sm" onClick={resetDocsAndAgreements}>
          Reset to defaults
        </button>
      </div>

      {/* ─── Agreements ─── */}
      <h3>
        ✍️ Agreements to sign <span className="badge">{state.agreements.length} items</span>
      </h3>
      <p className="sub">
        Order = sign order. Edit the wording under 📄 Agreement templates (matched by id).
      </p>
      {state.agreements.length === 0 ? (
        <p className="muted">No agreements configured.</p>
      ) : (
        state.agreements.map((agreement, i) => (
          <div className="row" key={agreement.kind}>
            <div className="field" style={{ minWidth: 260 }}>
              <input
                type="text"
                value={agreement.title}
                onChange={(e) => updateAgreement(i, { title: e.target.value })}
                placeholder="Agreement name (e.g. IC Agreement)"
              />
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={agreement.required}
                  onChange={(e) => updateAgreement(i, { required: e.target.checked })}
                />{' '}
                Required to sign
              </label>
            </div>
            <span className="badge">id: {agreement.kind}</span>
            <div className="actions">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => moveAgreement(i, -1)}
                disabled={i === 0}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => moveAgreement(i, 1)}
                disabled={i === state.agreements.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => removeAgreement(i)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
        ))
      )}
      <button type="button" className="btn ghost sm" onClick={addAgreement}>
        + Add agreement
      </button>

      {/* ─── Signature methods ─── */}
      <h3>🖊️ Signature methods</h3>
      <p className="sub">
        How each party signs agreements — typed name, drawn signature, or their choice.
      </p>
      <div className="row">
        <div className="field">
          <label htmlFor={sigContractorId}>Contractor — signs in the onboarding portal</label>
          <select
            id={sigContractorId}
            value={state.signature_methods.contractor}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                signature_methods: {
                  ...s.signature_methods,
                  contractor: e.target.value as OnboardingConfig['signature_methods']['contractor'],
                },
              }))
            }
          >
            {SIGNATURE_METHOD_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={sigCountersignerId}>
            Countersigner — signs for Aaron Anderson E.H.S. LLC
          </label>
          <select
            id={sigCountersignerId}
            value={state.signature_methods.countersigner}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                signature_methods: {
                  ...s.signature_methods,
                  countersigner: e.target
                    .value as OnboardingConfig['signature_methods']['countersigner'],
                },
              }))
            }
          >
            {SIGNATURE_METHOD_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ─── Onboarding emails ─── */}
      <h3>📧 Onboarding emails</h3>
      <p className="sub">
        Sent from your Gmail / Workspace account. Edit the wording below — changes save with the
        rest of this config.
      </p>
      <div className="field">
        <label htmlFor={autoSendId}>
          <input
            id={autoSendId}
            type="checkbox"
            checked={state.emails.auto_send}
            onChange={(e) =>
              setState((s) => ({ ...s, emails: { ...s.emails, auto_send: e.target.checked } }))
            }
          />{' '}
          Auto-send the welcome on hire
        </label>
      </div>
      <div className="row">
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor={portalUrlId}>Portal link</label>
          <input
            id={portalUrlId}
            type="text"
            value={state.emails.portal_url}
            onChange={(e) =>
              setState((s) => ({ ...s, emails: { ...s.emails, portal_url: e.target.value } }))
            }
          />
        </div>
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor={wiseUrlId}>Wise referral link</label>
          <input
            id={wiseUrlId}
            type="text"
            value={state.emails.wise_referral_url}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                emails: { ...s.emails, wise_referral_url: e.target.value },
              }))
            }
          />
        </div>
      </div>

      <h4>1 · Welcome email — sent at hire</h4>
      <div className="field">
        <label htmlFor={welcomeSubjectId}>Subject</label>
        <input
          id={welcomeSubjectId}
          type="text"
          value={state.emails.welcome.subject}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: { ...s.emails, welcome: { ...s.emails.welcome, subject: e.target.value } },
            }))
          }
        />
      </div>
      <div className="field">
        <label htmlFor={welcomeBodyId}>Body (HTML)</label>
        <textarea
          id={welcomeBodyId}
          rows={6}
          value={state.emails.welcome.html}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: { ...s.emails, welcome: { ...s.emails.welcome, html: e.target.value } },
            }))
          }
        />
        <p className="sub">
          Merge fields: {'{{name}}'} · {'{{wise_referral_url}}'} · {'{{portal_url}}'} ·{' '}
          {'{{email}}'} · {'{{password}}'}
        </p>
      </div>

      <h4>2 · Tool access email — sent when you provision tools at completion</h4>
      <div className="field">
        <label htmlFor={toolsSubjectId}>Subject</label>
        <input
          id={toolsSubjectId}
          type="text"
          value={state.emails.tools.subject}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: { ...s.emails, tools: { ...s.emails.tools, subject: e.target.value } },
            }))
          }
        />
      </div>
      <div className="field">
        <label htmlFor={toolsBodyId}>Body (HTML)</label>
        <textarea
          id={toolsBodyId}
          rows={6}
          value={state.emails.tools.html}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: { ...s.emails, tools: { ...s.emails.tools, html: e.target.value } },
            }))
          }
        />
        <p className="sub">
          Merge fields: {'{{name}}'} · {'{{tools_block}}'} ({'{{tools_block}}'} = the tool logins,
          filled in automatically).
        </p>
      </div>

      <h4>Password-reset email (used when you re-issue a temp password)</h4>
      <div className="field">
        <label htmlFor={credsSubjectId}>Subject</label>
        <input
          id={credsSubjectId}
          type="text"
          value={state.emails.credentials.subject}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: {
                ...s.emails,
                credentials: { ...s.emails.credentials, subject: e.target.value },
              },
            }))
          }
        />
      </div>
      <div className="field">
        <label htmlFor={credsBodyId}>Body (HTML)</label>
        <textarea
          id={credsBodyId}
          rows={6}
          value={state.emails.credentials.html}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              emails: {
                ...s.emails,
                credentials: { ...s.emails.credentials, html: e.target.value },
              },
            }))
          }
        />
        <p className="sub">
          Merge fields: {'{{name}}'} · {'{{portal_url}}'} · {'{{email}}'} · {'{{password}}'}
        </p>
      </div>
      <button type="button" className="btn ghost sm" onClick={resetEmailWording}>
        Reset email wording to defaults
      </button>

      {/* ─── Reminders ─── */}
      <h3>🔔 Document-review reminders</h3>
      <p className="sub">
        A digest to HR when new-hire documents are waiting for review. Runs on a daily cron; the
        frequency below decides which days actually send. Also needs Resend.
      </p>
      <div className="field">
        <label htmlFor={remindersEnabledId}>
          <input
            id={remindersEnabledId}
            type="checkbox"
            checked={state.reminders.enabled}
            onChange={(e) =>
              setState((s) => ({ ...s, reminders: { ...s.reminders, enabled: e.target.checked } }))
            }
          />{' '}
          Send reminders
        </label>
      </div>
      <div className="field">
        <label htmlFor={remindersDeferredId}>
          <input
            id={remindersDeferredId}
            type="checkbox"
            checked={state.reminders.include_deferred}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                reminders: { ...s.reminders, include_deferred: e.target.checked },
              }))
            }
          />{' '}
          Include deferred follow-ups
        </label>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={remindersFreqId}>Frequency</label>
          <select
            id={remindersFreqId}
            value={state.reminders.frequency}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                reminders: {
                  ...s.reminders,
                  frequency: e.target.value as OnboardingConfig['reminders']['frequency'],
                },
              }))
            }
          >
            {REMINDER_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 280 }}>
          <label htmlFor={remindersSendToId}>Send to (comma-separated)</label>
          <input
            id={remindersSendToId}
            type="text"
            value={state.reminders.send_to.join(', ')}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                reminders: {
                  ...s.reminders,
                  send_to: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v !== ''),
                },
              }))
            }
          />
        </div>
      </div>

      {/* ─── Advanced: raw JSON ─── */}
      <details
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) {
            setRawJson(JSON.stringify(state, null, 2));
            setRawError('');
          }
        }}
      >
        <summary>Advanced — preview / edit raw JSON</summary>
        <div className="field">
          <textarea
            id={rawJsonId}
            rows={12}
            value={rawJson}
            onChange={(e) => handleRawJsonChange(e.target.value)}
          />
          {rawError !== '' && <p className="sub error">{rawError}</p>}
        </div>
      </details>

      {/* ─── Footer ─── (legacy: single Save; Close lives in the Modal header) */}
      <div className="actions">
        <button type="button" className="btn" onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
};
