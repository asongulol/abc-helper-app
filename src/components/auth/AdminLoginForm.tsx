'use client';

import { type FormEvent, useId, useState } from 'react';
import { createBrowserSupabase } from '@/db/clients/browser';

type Busy = 'google' | 'password' | null;

/**
 * Admin sign-in — Google OAuth primary (legacy SignInScreen) with an
 * email/password fallback. On success the auth callback sets the session
 * cookie and the proxy gate routes the admin into the app.
 *
 * Two layouts share the same auth: the default "modern" card keeps Google first
 * and tucks the email/password form behind a secondary button; "Classic view"
 * (pinned bottom-left) shows the full single-screen form at once. The toggle is
 * presentation-only — both paths hit the same Supabase calls.
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
  // 'modern' = the reference card (Google first, email behind a click);
  // 'classic' = the legacy single-screen form (everything visible at once).
  const [view, setView] = useState<'modern' | 'classic'>('modern');
  // In modern mode, whether the email/password fields are revealed. On the local
  // stack Google is disabled, so the email fallback opens straight away.
  const [emailOpen, setEmailOpen] = useState(isLocalStack);

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

  // Email is the focused path when on local (Google off) or when the user opened
  // it in modern mode — give its submit the primary (navy) weight then.
  const emailIsPrimary = isLocalStack || (view === 'modern' && emailOpen);

  const emailForm = (
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
        className={emailIsPrimary ? 'btn' : 'btn ghost'}
        disabled={busy !== null}
        style={{ marginTop: 12 }}
      >
        {busy === 'password' ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );

  return (
    <div className="login-actions">
      <button
        type="button"
        className={isLocalStack ? 'btn ghost' : 'btn'}
        disabled={busy !== null}
        onClick={signInWithGoogle}
      >
        {busy === 'google' ? 'Redirecting…' : 'Sign in with Google'}
      </button>

      {view === 'classic' ? (
        <>
          <div className="login-divider">or with email</div>
          {emailForm}
        </>
      ) : emailOpen ? (
        emailForm
      ) : (
        <button type="button" className="btn ghost" onClick={() => setEmailOpen(true)}>
          Sign in with email
        </button>
      )}

      {isLocalStack && (
        <p className="sub" style={{ fontSize: 12, margin: 0 }}>
          Google isn&apos;t enabled on the local stack — use email.
        </p>
      )}

      {err && (
        <div className="banner error" style={{ textAlign: 'left', margin: 0 }} role="alert">
          {err}
        </div>
      )}

      <button
        type="button"
        className="classic-toggle"
        onClick={() => setView((v) => (v === 'modern' ? 'classic' : 'modern'))}
      >
        <span aria-hidden="true">↩</span> {view === 'modern' ? 'Classic view' : 'Modern view'}
      </button>
    </div>
  );
};
