'use client';

import Script from 'next/script';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { createBrowserSupabase } from '@/db/clients/browser';

/**
 * Contractor portal sign-in — email/password with a self-serve password reset.
 *
 * Cloudflare Turnstile (§7.6): rendered only when NEXT_PUBLIC_TURNSTILE_SITE_KEY
 * is configured. Its single-use token is attached to signInWithPassword /
 * resetPasswordForEmail via `options.captchaToken`; we never client-block on it
 * (Supabase Auth is the enforcer when the project has Turnstile enabled).
 */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileWindow = Window & {
  __abcTurnstileToken?: ((token: string) => void) | undefined;
};

export const PortalLoginForm = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const emailId = useId();
  const passwordId = useId();

  // Turnstile invokes a named global callback with the token; mirror it to state.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    (window as TurnstileWindow).__abcTurnstileToken = (token: string) => setCaptchaToken(token);
    return () => {
      (window as TurnstileWindow).__abcTurnstileToken = undefined;
    };
  }, []);

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
      ...(captchaToken ? { captchaToken } : {}),
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
      {TURNSTILE_SITE_KEY && (
        <>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          <div
            className="cf-turnstile"
            data-sitekey={TURNSTILE_SITE_KEY}
            data-callback="__abcTurnstileToken"
            style={{ marginTop: 8 }}
          />
        </>
      )}
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
