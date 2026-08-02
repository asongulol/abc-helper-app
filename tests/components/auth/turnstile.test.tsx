/**
 * Turnstile widget gating.
 *
 * The property that matters here is the OFF branch. Captcha protection was
 * enabled on the Supabase project while the site key was configured on the
 * wrong Vercel project, so the app rendered no widget, attached no token, and
 * every password sign-in came back "captcha protection: request disallowed
 * (no captcha_token found)". Both sign-in forms now share this component, so if
 * the unconfigured branch ever stopped rendering nothing, it would break sign-in
 * on the local stack and anywhere else the key is deliberately absent.
 *
 * Note the site key is read at module scope: Next inlines NEXT_PUBLIC_* at build
 * time, which is why adding the var to Vercel needs a redeploy to take effect.
 * Hence resetModules() around each case rather than mutating env in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY';
const original = process.env[KEY];

const loadWidget = async (siteKey: string | undefined) => {
  vi.resetModules();
  if (siteKey === undefined) delete process.env[KEY];
  else process.env[KEY] = siteKey;
  return (await import('@/components/auth/Turnstile')).TurnstileWidget;
};

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('TurnstileWidget', () => {
  it('renders nothing when no site key is configured', async () => {
    const TurnstileWidget = await loadWidget(undefined);
    expect(TurnstileWidget({})).toBeNull();
  });

  it('renders the challenge carrying the configured site key', async () => {
    const TurnstileWidget = await loadWidget('0x4AAAAAAAtest_site_key');
    const rendered = TurnstileWidget({});
    expect(rendered).not.toBeNull();
    // The site key has to reach the DOM node Cloudflare reads it from, and the
    // callback name has to match the one useTurnstileToken registers globally.
    expect(JSON.stringify(rendered)).toContain('0x4AAAAAAAtest_site_key');
    expect(JSON.stringify(rendered)).toContain('__abcTurnstileToken');
  });
});
