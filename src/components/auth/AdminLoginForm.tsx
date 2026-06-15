'use client';

import { createBrowserSupabase } from '@/db/clients/browser';
import { type FormEvent, useId, useState } from 'react';

type Busy = 'google' | 'password' | null;

/**
 * Admin sign-in — Google OAuth primary (legacy SignInScreen) with an
 * email/password fallback. On success the auth callback sets the session
 * cookie and the proxy gate routes the admin into the app.
 */
export const AdminLoginForm = () => {
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const emailId = useId();
  const passwordId = useId();
  // Google OAuth isn't wired on the local Supabase stack — steer dev sign-in to email.
  const isLocalStack = /127\.0\.0\.1|localhost/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');

  const signInWithGoogle = async () => {
    setBusy('google');
    setErr('');
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    });
    // On success the browser redirects to Google; on failure we stay and show why.
    if (error) {
      setErr(`${error.message} — is the Google provider enabled in Supabase Auth?`);
      setBusy(null);
    }
  };

  const signInWithPassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy('password');
    setErr('');
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) {
      setErr(error.message);
      setBusy(null);
      return;
    }
    window.location.href = '/overview';
  };

  return (
    <div>
      <button
        type="button"
        className={isLocalStack ? 'btn ghost' : 'btn'}
        style={{ width: '100%' }}
        disabled={busy !== null}
        onClick={signInWithGoogle}
      >
        {busy === 'google' ? 'Redirecting…' : 'Sign in with Google'}
      </button>
      {isLocalStack && (
        <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
          Google isn&apos;t enabled on the local stack — use email below.
        </p>
      )}
      <div
        className="muted"
        style={{
          margin: '14px 0 10px',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
        }}
      >
        or with email
      </div>
      <form onSubmit={signInWithPassword} style={{ textAlign: 'left' }}>
        <div className="field" style={{ minWidth: 0 }}>
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            type="email"
            autoComplete="username"
            placeholder="you@abckidsny.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </div>
        <div className="field" style={{ minWidth: 0 }}>
          <label htmlFor={passwordId}>Password</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%', marginBottom: 0 }}
          />
        </div>
        <button
          type="submit"
          className={isLocalStack ? 'btn' : 'btn ghost'}
          style={{ width: '100%' }}
          disabled={busy !== null}
        >
          {busy === 'password' ? 'Signing in…' : 'Sign in with email'}
        </button>
      </form>
      {err && (
        <div className="banner error" style={{ marginTop: 12, textAlign: 'left' }} role="alert">
          {err}
        </div>
      )}
    </div>
  );
};
