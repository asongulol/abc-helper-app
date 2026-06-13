'use client';

import { createBrowserSupabase } from '@/db/clients/browser';
import { type FormEvent, useId, useState } from 'react';

/**
 * Contractor portal sign-in — email/password with a self-serve password
 * reset, port of the legacy portal Login.
 *
 * TODO(turnstile): the legacy portal rendered a Cloudflare Turnstile widget
 * here and attached its single-use token to signInWithPassword /
 * resetPasswordForEmail (`options.captchaToken`), never client-blocking on it.
 * Re-add the widget when the Turnstile site key is configured.
 */
export const PortalLoginForm = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');
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
    });
    if (error) {
      setErr(error.message);
      setBusy(false);
      return;
    }
    window.location.href = '/portal';
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
      redirectTo: `${location.origin}/auth/callback?next=/portal`,
    });
    if (error) setErr(error.message);
    else setSent('Password-reset email sent — check your inbox.');
  };

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
      />
      {err && (
        <div className="err" role="alert">
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
