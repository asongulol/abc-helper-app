'use client';

import { useEffect, useState } from 'react';
import { AGREEMENT_TITLE } from '@/components/print/AgreementPrint';
import { Badge, Spinner } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import { fmtDate, fmtDateTime } from '@/lib/format';
import {
  createPortalLogin,
  getPortalAccess,
  type PortalAccess,
  resetPortalPassword,
  restorePortalLogin,
  revokePortalLogin,
} from '@/server/actions/portal-admin';

const EVENT_LABEL: Record<string, string> = {
  'portal_login.created': 'Login created',
  'portal_login.reset_password': 'Password reset',
  'portal_login.email_changed': 'Login email changed',
  'portal_login.revoked': 'Login revoked',
  'portal_login.restored': 'Login restored',
  'portal_login.resend_hire_emails': 'Hire emails re-sent',
  'portal_login.send_tools_email': 'Tools email sent',
  'portal.signed_in': 'Signed in',
  'document.viewed': 'Viewed',
  'document.downloaded': 'Downloaded',
  'agreement.viewed': 'Viewed agreement',
};

/** One-line description of an access event, e.g. "Downloaded Passport (1).jpg". */
const describe = (h: PortalAccess['history'][number]): string => {
  const base = EVENT_LABEL[h.action] ?? h.action;
  const d = h.detail ?? {};
  if (h.action.startsWith('document.'))
    return `${base} ${String(d.title ?? d.kind ?? 'a document')}`;
  if (h.action === 'agreement.viewed') {
    const kind = String(d.kind ?? '');
    return `${base} · ${AGREEMENT_TITLE[kind] ?? kind}${d.version ? ` v${String(d.version)}` : ''}`;
  }
  return base;
};

interface Props {
  worker: RosterWorker;
  loginBusy: boolean;
  portalCreds: { tempPassword: string; emailSent: boolean; email: string | null } | null;
  runLogin: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  /** Spread of the shell's tablist.panelProps() — makes this div the active tabpanel. */
  panelProps: { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: number };
}

/** Portal & login tab — self-service login provisioning (decoupled from the profile form). */
export function PortalLoginTab({ worker, loginBusy, portalCreds, runLogin, panelProps }: Props) {
  const [access, setAccess] = useState<PortalAccess | null>(null);
  const [accessErr, setAccessErr] = useState('');
  // Load on mount and again each time a login action settles (busy → idle).
  useEffect(() => {
    if (loginBusy) return;
    let alive = true;
    getPortalAccess({ workerId: worker.workerId }).then((res) => {
      if (!alive) return;
      if (res.ok) setAccess(res.data);
      else setAccessErr(res.error);
    });
    return () => {
      alive = false;
    };
  }, [worker.workerId, loginBusy]);
  const login = access?.login ?? null;
  // Until the lookup answers, the buttons stay enabled as they always were.
  const known = access !== null;

  return (
    <div
      {...panelProps}
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 12,
        marginTop: 8,
      }}
    >
      <div className="card-head">
        <div>
          <b>Self-service portal login</b>
          <div className="sub" style={{ fontSize: 12, maxWidth: 420 }}>
            Lets this contractor sign in at the portal to view <b>only their own</b> pay, time, and
            documents (read-only).
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn sm"
            disabled={loginBusy || !worker.email || login?.status === 'active'}
            title={
              login?.status === 'active'
                ? 'Already has an active login.'
                : worker.email
                  ? ''
                  : 'Set a personal email first.'
            }
            onClick={() =>
              runLogin(
                () =>
                  createPortalLogin({
                    workerId: worker.workerId,
                    email: worker.email ?? '',
                  }),
                'Portal login created.',
              )
            }
          >
            {loginBusy ? <Spinner /> : 'Create portal login'}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={loginBusy}
            onClick={() =>
              runLogin(
                () => resetPortalPassword({ workerId: worker.workerId }),
                'Password reset — share the new temp password below.',
              )
            }
          >
            Reset password
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={loginBusy || (known && login?.status !== 'active')}
            onClick={() => {
              if (
                !window.confirm(
                  'Revoke this contractor’s portal access? They will be signed out and can no longer log in until you create a new login.',
                )
              ) {
                return;
              }
              runLogin(
                () => revokePortalLogin({ workerId: worker.workerId }),
                'Portal access revoked.',
              );
            }}
          >
            Revoke login
          </button>
          {/* The undo for the nightly sunset sweep — without it an automatic (or
              mistaken) revocation has no way back. Gated on the access lookup
              below; restorePortalLogin still answers "no login yet" itself. */}
          <button
            type="button"
            className="btn ghost sm"
            disabled={loginBusy || (known && login?.status !== 'revoked')}
            title="Give a revoked portal login back — use this if access was ended in error, or if their pay was re-drafted after it landed."
            onClick={() =>
              runLogin(
                () => restorePortalLogin({ workerId: worker.workerId }),
                'Portal access restored.',
              )
            }
          >
            Restore login
          </button>
        </div>
      </div>
      <div
        style={{
          marginTop: 8,
          padding: '8px 12px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {!known && !accessErr ? (
          <Spinner />
        ) : accessErr ? (
          <span className="sub">{accessErr}</span>
        ) : !login ? (
          <>
            <Badge tone="neutral">No portal login</Badge>
            <span className="sub">Create one to give this contractor access.</span>
          </>
        ) : (
          <>
            <Badge tone={login.status === 'active' ? 'good' : 'bad'}>
              {login.status === 'active' ? 'Access active' : `Access ${login.status}`}
            </Badge>
            <span className="sub">{login.email ?? '—'}</span>
            <span className="sub">Granted {fmtDate(login.createdAt)}</span>
            <span className="sub">
              Last sign-in {login.lastSignInAt ? fmtDateTime(login.lastSignInAt) : 'never'}
            </span>
          </>
        )}
      </div>
      {access && (
        <div style={{ marginTop: 16 }}>
          <b>Access history</b>
          {access.history.length === 0 ? (
            <p className="sub" style={{ margin: '4px 0 0', fontSize: 12 }}>
              Nothing recorded yet — sign-ins, views and downloads appear here from now on.
            </p>
          ) : (
            <div className="table-scroll" style={{ marginTop: 6 }}>
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {access.history.map((h) => (
                    <tr key={h.id}>
                      <td>{fmtDateTime(h.at)}</td>
                      <td>{describe(h)}</td>
                      <td>{h.actor ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {portalCreds &&
        (portalCreds.emailSent ? (
          <div
            className="banner"
            style={{
              marginTop: 8,
              background: 'var(--good-soft)',
              borderColor: 'var(--good)',
              color: 'var(--good)',
            }}
          >
            ✉ Credentials emailed to <b>{portalCreds.email ?? 'the contractor'}</b> — they can sign
            in with them right away (they&apos;ll be asked to change the password). Backup in case
            it doesn&apos;t arrive:
            <br />
            <b>Temp password:</b> <code>{portalCreds.tempPassword}</code>
          </div>
        ) : (
          <div
            className="banner"
            style={{
              marginTop: 8,
              background: 'var(--warn-soft, #fef9c3)',
              borderColor: 'var(--warn)',
              color: 'var(--warn)',
            }}
          >
            ⚠ The credentials email could <b>not</b> be sent — share these with the contractor
            yourself (they should change the password after first sign-in):
            <br />
            <b>Temp password:</b> <code>{portalCreds.tempPassword}</code>
          </div>
        ))}
      {worker.wiseTag && (
        <div
          className="banner"
          style={{
            marginTop: 8,
            background: 'var(--navy-50)',
            borderColor: '#bfdbfe',
            color: 'var(--navy)',
          }}
        >
          <b>Wise Tag from contractor:</b> <code>{worker.wiseTag}</code> — use this to set up their
          Wise recipient (then store the recipient ID/UUID on the <b>Pay &amp; payout</b> tab).
        </div>
      )}
    </div>
  );
}
