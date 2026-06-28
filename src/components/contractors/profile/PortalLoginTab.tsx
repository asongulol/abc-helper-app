import { Spinner } from '@/components/ui';
import type { RosterWorker } from '@/db/queries/workers';
import {
  createPortalLogin,
  resetPortalPassword,
  revokePortalLogin,
} from '@/server/actions/portal-admin';

interface Props {
  worker: RosterWorker;
  loginBusy: boolean;
  tempPassword: string | null;
  runLogin: (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => void;
  /** Spread of the shell's tablist.panelProps() — makes this div the active tabpanel. */
  panelProps: { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: number };
}

/** Portal & login tab — self-service login provisioning (decoupled from the profile form). */
export function PortalLoginTab({ worker, loginBusy, tempPassword, runLogin, panelProps }: Props) {
  return (
    <div
      {...panelProps}
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 12,
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
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
        </div>
      </div>
      {tempPassword && (
        <div
          className="banner"
          style={{
            marginTop: 8,
            background: '#ecfdf5',
            borderColor: '#a7f3d0',
            color: '#065f46',
          }}
        >
          Portal credentials — share these <b>once</b> (the contractor should change the password
          after first sign-in):
          <br />
          <b>Temp password:</b> <code>{tempPassword}</code>
        </div>
      )}
      {worker.wiseTag && (
        <div
          className="banner"
          style={{
            marginTop: 8,
            background: '#eff6ff',
            borderColor: '#bfdbfe',
            color: '#1e40af',
          }}
        >
          <b>Wise Tag from contractor:</b> <code>{worker.wiseTag}</code> — use this to set up their
          Wise recipient (then store the recipient ID/UUID on the <b>Pay &amp; payout</b> tab).
        </div>
      )}
    </div>
  );
}
