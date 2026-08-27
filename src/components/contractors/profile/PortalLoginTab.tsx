import { Spinner } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import {
  createPortalLogin,
  resetPortalPassword,
  restorePortalLogin,
  revokePortalLogin,
} from '@/server/actions/portal-admin';

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
            disabled={loginBusy || !worker.email}
            title={worker.email ? '' : 'Set a personal email first.'}
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
            disabled={loginBusy}
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
              mistaken) revocation has no way back. ponytail: always enabled, no
              login-status gate: RosterWorker doesn't carry contractor_logins.status,
              and restorePortalLogin already answers "no login yet" and "already
              active" itself. Add the gate only if the extra query earns its keep. */}
          <button
            type="button"
            className="btn ghost sm"
            disabled={loginBusy}
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
