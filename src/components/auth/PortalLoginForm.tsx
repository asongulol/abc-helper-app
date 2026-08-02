'use client';

import { type FormEvent, useId, useState } from 'react';
import { createBrowserSupabase } from '@/db/clients/browser';
import { safeNext } from '@/lib/auth/safe-next';
import { TurnstileWidget, useTurnstileToken } from './Turnstile';

/** Post-login destination from `?next=`, constrained to a portal path (#045). */
const postLoginDest = (): string => {
  const n = safeNext(new URLSearchParams(window.location.search).get('next'));
  return n.startsWith('/portal') && n !== '/portal/login' ? n : '/portal';
};

/**
 * Contractor portal sign-in — email/password with a self-serve password reset.
 *
 * Cloudflare Turnstile lives in ./Turnstile, shared with the admin form.
 */
export const PortalLoginForm = ({ accessEnded }: { accessEnded: boolean }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');
  const captchaToken = useTurnstileToken();
  const emailId = useId();
  const passwordId = useId();

  const signIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    setSent('');
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    window.location.href = postLoginDest();
  };

  const reset = async () => {
    if (!email.trim()) {
      setErr('Enter your email first, then tap reset.');
      return;
    }
    setErr('');
    setSent('');
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${location.origin}/auth/callback?next=/portal/reset-password`,
      ...(captchaToken ? { captchaToken } : {}),
    });
    if (error) setErr(error.message);
    else setSent('Password-reset email sent — check your inbox.');
  };

  // Signed in, but their engagement is over and the last payment has landed.
  // Showing the form again would read as a rejected password, so say what
  // actually happened — and still leave a way back to it, since a contractor
  // and a partner sometimes share one device.
  if (accessEnded) {
    return (
      <div className="card">
        <h3 style={{ margin: '0 0 6px' }}>Your portal access has ended</h3>
        <p className="sub" style={{ margin: 0 }}>
          Your engagement is closed and your final payment has been sent. For a copy of a payslip,
          statement, or document, contact your payroll admin — they can still send you everything on
          file.
        </p>
        <button
          type="button"
          className="btn link"
          style={{ marginTop: 12 }}
          onClick={async () => {
            await createBrowserSupabase().auth.signOut({ scope: 'local' });
            window.location.href = '/portal/login';
          }}
        >
          Sign in as someone else
        </button>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={signIn}>
      <label className="sub" htmlFor={emailId}>
        Email
      </label>
      <input
        id={emailId}
        type="email"
        autoComplete="username"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        aria-invalid={err ? 'true' : undefined}
        aria-describedby={err ? 'portal-login-err' : undefined}
      />
      <label className="sub" htmlFor={passwordId}>
        Password
      </label>
      <input
        id={passwordId}
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        aria-invalid={err ? 'true' : undefined}
        aria-describedby={err ? 'portal-login-err' : undefined}
      />
      <TurnstileWidget />
      {err && (
        <div id="portal-login-err" className="err" role="alert">
          {err}
        </div>
      )}
      {sent && <div style={{ color: 'var(--good)', fontSize: 14, padding: '6px 0' }}>{sent}</div>}
      <button type="submit" className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <div style={{ textAlign: 'center', marginTop: 6 }}>
        <button type="button" className="btn link" onClick={reset} disabled={busy}>
          Forgot / set password
        </button>
      </div>
    </form>
  );
};
