'use client';

import { type InputHTMLAttributes, useId } from 'react';

/**
 * Domains ordered by approximate global mailbox count: Gmail far ahead, then the
 * big consumer providers, then large legacy/regional ones. Pass `work` to pin the
 * company domains to the front (work-email fields), or `pin` to supply your own
 * front-of-list domains.
 */
const EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'gmx.com',
  'yandex.com',
  'live.com',
  'msn.com',
  'mail.com',
];

/** Company domains pinned to the front when `work` is set. */
const WORK_EMAIL_DOMAINS = ['abckidsny.com', '123babytalks.com', 'abbilabs.com'];

/**
 * Build `local@domain` completions from what's typed. Once a domain is started
 * after "@", narrow to domains that begin with it; cap the list so it stays tidy.
 */
function emailSuggestions(value: string, domains: string[]): string[] {
  const v = value ?? '';
  const at = v.indexOf('@');
  const local = (at >= 0 ? v.slice(0, at) : v).trim();
  if (!local) return [];
  const typed = (at >= 0 ? v.slice(at + 1) : '').toLowerCase();
  return domains
    .filter((d) => !typed || d.startsWith(typed))
    .slice(0, 8)
    .map((d) => `${local}@${d}`);
}

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'list'
>;

export interface EmailInputProps extends NativeInputProps {
  value: string;
  /** Emits the raw string (not an event) so callers store a plain value. */
  onChange: (value: string) => void;
  /** Pin the company work domains to the front of the suggestions. */
  work?: boolean | undefined;
  /** Supply your own front-of-list domains (overrides the work pins). */
  pin?: string[] | undefined;
}

/**
 * Drop-in for `<input type="email">` with domain autocomplete via a native
 * `<datalist>` (degrades to a plain field where datalist is unsupported).
 * Faithful port of the legacy EmailInput.
 */
export const EmailInput = ({ value, onChange, work, pin, ...rest }: EmailInputProps) => {
  const id = useId();
  const domains = [...new Set([...(pin ?? (work ? WORK_EMAIL_DOMAINS : [])), ...EMAIL_DOMAINS])];
  const opts = emailSuggestions(value, domains);
  return (
    <>
      <input
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        list={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      <datalist id={id}>
        {opts.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
};
