'use client';

import Script from 'next/script';
import { type CSSProperties, useEffect, useState } from 'react';

/**
 * Cloudflare Turnstile, shared by both sign-in forms (§7.6).
 *
 * Rendered only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. The single-use
 * token is attached to signInWithPassword / resetPasswordForEmail via
 * `captchaToken`; we never client-block on it — Supabase Auth is the enforcer
 * when the project has captcha protection turned on.
 *
 * This lives in one place because it did not used to. The portal form attached
 * a token and the admin form had no captcha support at all, so the day captcha
 * was enabled on the Supabase project, admin password sign-in started failing
 * with "captcha protection: request disallowed (no captcha_token found)" while
 * Google SSO kept working and hid it. One shared widget means enabling captcha
 * can no longer break one sign-in path and not the other.
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileWindow = Window & {
  __abcTurnstileToken?: ((token: string) => void) | undefined;
};

/**
 * The token from the rendered widget, or undefined when Turnstile is not
 * configured — in which case the auth call is made without one, exactly as
 * before. Turnstile invokes a named global callback; this mirrors it to state.
 */
export const useTurnstileToken = (): string | undefined => {
  const [token, setToken] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    (window as TurnstileWindow).__abcTurnstileToken = (t: string) => setToken(t);
    return () => {
      (window as TurnstileWindow).__abcTurnstileToken = undefined;
    };
  }, []);
  return token;
};

/** The widget itself — renders nothing when no site key is configured. */
export const TurnstileWidget = ({ style }: { style?: CSSProperties }) =>
  TURNSTILE_SITE_KEY ? (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <div
        className="cf-turnstile"
        data-sitekey={TURNSTILE_SITE_KEY}
        data-callback="__abcTurnstileToken"
        style={style ?? { marginTop: 8 }}
      />
    </>
  ) : null;
