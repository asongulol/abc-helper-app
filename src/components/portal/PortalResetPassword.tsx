'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useState } from 'react';
import { useToast } from '@/components/ui';
import { createBrowserSupabase } from '@/db/clients/browser';

// Mirrors supabase/config.toml auth.minimum_password_length.
const MIN_PASSWORD_LENGTH = 6;

/**
 * Set-new-password page — the destination for both the "Forgot / set
 * password" email flow and any first-time recovery link. The (authed) layout
 * has already verified the session (a recovery session resolves
 * getCurrentWorker() the same as a normal login), so this is just the form.
 */
export const PortalResetPassword = () => {
  const router = useRouter();
  const { notify } = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const passwordId = useId();
  const confirmId = useId();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErr(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    setBusy(true);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    notify('Password updated.', { type: 'success' });
    router.replace('/portal');
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Set a new password</h2>
      <p className="sub">Choose a new password for your contractor portal account.</p>
      <form onSubmit={submit}>
        <label className="sub" htmlFor={passwordId}>
          New password
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={err ? 'true' : undefined}
          aria-describedby={err ? 'reset-password-err' : undefined}
        />
        <label className="sub" htmlFor={confirmId}>
          Confirm password
        </label>
        <input
          id={confirmId}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={err ? 'true' : undefined}
          aria-describedby={err ? 'reset-password-err' : undefined}
        />
        {err && (
          <div id="reset-password-err" className="err" role="alert">
            {err}
          </div>
        )}
        <button
          type="submit"
          className="btn"
          style={{ width: '100%', marginTop: 8 }}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </div>
  );
};
