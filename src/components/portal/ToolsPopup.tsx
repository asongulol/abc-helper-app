'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, useToast } from '@/components/ui';
import { ackMyTools, revealMyTools } from '@/server/actions/portal';

/**
 * Tools reveal (§10.6). Shown when worker_tools.popup_pending. Calls get_my_tools,
 * which decrypts and returns the credentials persistently (shared-prod model — it
 * does NOT purge enc). The fetch is ref-guarded only to avoid a double-call on
 * mount; "Got it" acknowledges (ackMyTools clears the pending flag).
 */
export const ToolsPopup = ({ pending }: { pending: boolean }) => {
  const { notify } = useToast();
  const [open, setOpen] = useState(pending);
  const [creds, setCreds] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(pending);
  const revealed = useRef(false);

  useEffect(() => {
    if (!pending || revealed.current) return;
    revealed.current = true;
    void (async () => {
      const res = await revealMyTools();
      setLoading(false);
      if (res.ok && res.data?.creds && typeof res.data.creds === 'object') {
        setCreds(res.data.creds as Record<string, unknown>);
      } else {
        // already revealed / nothing to show — close quietly
        setOpen(false);
      }
    })();
  }, [pending]);

  const dismiss = async () => {
    setOpen(false);
    const res = await ackMyTools();
    if (!res.ok) notify(res.error, { type: 'error' });
  };

  if (!open) return null;

  return (
    <Modal title="Your tool logins" onClose={dismiss} maxWidth={460}>
      {loading ? (
        <p className="sub">Loading…</p>
      ) : creds ? (
        <>
          <p className="sub">
            These are shown once — save them now and change any password on first sign-in.
          </p>
          <div style={{ display: 'grid', gap: 10, margin: '12px 0' }}>
            {Object.entries(creds).map(([tool, fields]) => (
              <div
                key={tool}
                style={{
                  padding: '8px 12px',
                  background: 'var(--surface2)',
                  borderRadius: 6,
                }}
              >
                <strong style={{ textTransform: 'capitalize' }}>{tool}</strong>
                <div className="sub" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
                  {fields && typeof fields === 'object'
                    ? Object.entries(fields as Record<string, unknown>)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join('\n')
                    : String(fields)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="sub">No tool logins to show.</p>
      )}
      <button type="button" className="btn" onClick={dismiss}>
        Got it
      </button>
    </Modal>
  );
};
