/**
 * Agreement merge + signature-safety helpers — pure (no `server-only`, no DOM)
 * so they run in Server Components, Client Components, and unit tests alike.
 *
 * Ported from the legacy single-file app's `mergeAgreement` / `monthlyFromPeriod`
 * / `safeSigImg` / signature `mark` (app/index.html ~10606–10816). The security
 * boundary is `safeSigImg`: signature data is user-controlled, so a captured
 * data-URI is only ever emitted as an <img> when it is a bounded
 * `data:image/(png|jpe?g|webp);base64,…` string (a charset that cannot contain a
 * quote or `<`, so it can't break out of an attribute or tag). Anything else
 * falls back to the escaped typed name. Routes render via the structured
 * `renderAgreementParts` selector (safe JSX) rather than dangerouslySetInnerHTML.
 */

/** HTML-escape any value (null/undefined → ''). Mirrors the legacy escapeHtml. */
export function escapeHtml(x: unknown): string {
  return String(x == null ? '' : x).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[c] ?? c,
  );
}

/**
 * Monthly rate from a per-period (semi-monthly) rate string: payroll is twice a
 * month, so ×2, rounded to cents, locale-formatted. '' when unparseable/≤0.
 */
export function monthlyFromPeriod(rate: unknown): string {
  const n = Number.parseFloat(String(rate == null ? '' : rate).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  return (Math.round(n * 2 * 100) / 100).toLocaleString('en-US');
}

/** Variables accepted by mergeAgreement (all optional; defaults applied). */
export type AgreementVars = {
  contractor_name?: string | null | undefined;
  rate?: string | null | undefined;
  monthly_rate?: string | null | undefined;
  company_name?: string | null | undefined;
  employer_name?: string | null | undefined;
  start_date?: string | null | undefined;
  position?: string | null | undefined;
  contractor_address?: string | null | undefined;
  countersigner_name?: string | null | undefined;
  today?: string | null | undefined;
  employment_type?: string | null | undefined;
  hours_per_week?: string | number | null | undefined;
  schedule?: string | null | undefined;
  addendum?: string | null | undefined;
};

/**
 * Fill `{{token}}` fields in an agreement body and auto-append the engagement
 * basis (employment type + shift) + the DST note when those tokens are set but
 * not placed inline. Returns plain text (the caller renders it as text, never
 * HTML). Faithful port of the legacy mergeAgreement.
 */
export function mergeAgreement(body: string | null | undefined, vars?: AgreementVars): string {
  const v = vars ?? {};
  const empRaw = v.employment_type || '';
  const empLabel =
    empRaw === 'full_time' ? 'Full-time' : empRaw === 'part_time' ? 'Part-time' : empRaw || '';
  const empHours =
    v.hours_per_week != null && String(v.hours_per_week).trim() !== ''
      ? String(v.hours_per_week).trim()
      : empRaw === 'full_time'
        ? '40'
        : empRaw === 'part_time'
          ? '20'
          : '';
  const empPhrase = empLabel ? empLabel + (empHours ? ` (${empHours} hours/week)` : '') : '';
  const sched = v.schedule || '';
  const s: Record<string, string> = {
    contractor_name: v.contractor_name || '',
    rate: v.rate || '________',
    monthly_rate: v.monthly_rate || '________',
    company_name: v.company_name || '________',
    client_name: v.company_name || '________',
    employer_name: v.employer_name || 'Aaron Anderson E.H.S. LLC',
    start_date: v.start_date || '________',
    position: v.position || '________',
    contractor_address: v.contractor_address || '________',
    countersigner_name: v.countersigner_name || '________',
    today: v.today || '',
    employment_type: empPhrase || '________',
    hours_per_week: empHours || '________',
    schedule: sched || '________',
    addendum: v.addendum || '',
  };
  const src = String(body || '');
  let out = src.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => s[k] ?? m);
  if (s.addendum && !/\{\{\s*addendum\s*\}\}/.test(src)) out += `\n\n${s.addendum}`;
  // Auto-append the engagement basis + DST note when set and the template
  // doesn't already place those tokens — so every agreement states it.
  if (
    !/\{\{\s*(employment_type|hours_per_week|schedule)\s*\}\}/.test(src) &&
    (empPhrase || sched)
  ) {
    const bits: string[] = [];
    if (empPhrase) bits.push(`Engagement: ${empPhrase}.`);
    if (sched) bits.push(`Work schedule: ${sched}.`);
    if (sched)
      bits.push(
        'This schedule is stated in U.S. Eastern Time, which observes U.S. daylight saving time. Because the Philippines does not change its clocks, the equivalent local Philippine start and end times shift by one hour when the U.S. springs forward (mid-March) and falls back (early November).',
      );
    out += `\n\n${bits.join(' ')}`;
  }
  return out;
}

/** ~1MB cap on an accepted signature data-URI (defensive bound). */
const MAX_SIG_DATA_URI_LEN = 1_400_000;

/**
 * Return the data-URI ONLY when it is a clean, bounded
 * `data:image/(png|jpe?g|webp);base64,…` string (that charset cannot contain a
 * quote or `<`, so there's no attribute/tag breakout). Otherwise ''.
 *
 * This is the stored-XSS boundary: `javascript:`, `data:text/html`, anything
 * containing a quote or `<`, oversized blobs, and garbage are all rejected.
 */
export function safeSigImg(d: unknown): string {
  const s = String(d == null ? '' : d);
  if (s.length > MAX_SIG_DATA_URI_LEN) return '';
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(s) ? s : '';
}

/** A rendered signature: either a safe image data-URI, or an escaped name. */
export type SignatureMark = { imgSrc: string } | { name: string };

/**
 * Resolve a captured signature to either a safe <img> source (drawn + valid
 * data-URI) or the escaped typed name. Mirrors the legacy `mark()` helper, but
 * returns structured data instead of an HTML string so callers can render with
 * safe JSX.
 */
export function signatureMark(sig: {
  method?: string | null;
  data?: unknown;
  name?: string | null;
}): SignatureMark {
  const img = sig.method === 'drawn' ? safeSigImg(sig.data) : '';
  return img ? { imgSrc: img } : { name: escapeHtml(sig.name) };
}

/** A single signature line in the rendered agreement. */
export type AgreementSignatory = {
  /** Safe image data-URI, when the signature is a valid drawn data-URI. */
  imgSrc?: string | undefined;
  /** Escaped fallback name shown when there is no safe image. */
  name?: string | undefined;
  /** The party label, e.g. "Contractor — Jane Doe" or "For Aaron Anderson E.H.S. LLC — …". */
  label: string;
  /** A status/meta line, e.g. "Signed 2026-01-04 · IP 1.2.3.4" or "Not yet signed". */
  meta: string;
};

export type AgreementParts = {
  /** Plain merged agreement text (render inside a <pre>, as text). */
  mergedText: string;
  contractor: AgreementSignatory;
  countersign: AgreementSignatory;
};

/** A contractor signature row (subset of onboarding_signatures, already mapped). */
export type SignatureInput = {
  signatureMethod?: string | null;
  signatureData?: unknown;
  signedLegalName?: string | null;
  signedDate?: string | null;
  signedAt?: string | null;
  ipAddress?: unknown;
} | null;

/** An agreement countersign row (subset of onboarding_agreements, already mapped). */
export type CountersignInput = {
  countersignMethod?: string | null;
  countersignData?: unknown;
  countersignedName?: string | null;
  countersignerName?: string | null;
  countersignedAt?: string | null;
  countersignIp?: unknown;
} | null;

/** ISO date (YYYY-MM-DD) from an ISO date-or-timestamp; '' when empty/invalid. */
function isoDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v.includes('T') ? v : `${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Locale date-time string from an ISO timestamp; '' when empty/invalid. */
function localeDateTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Structured selector: merge the body, then resolve both signature lines to
 * safe parts. The ONLY signature value that can carry markup is the drawn-image
 * data-URI — and that is gated by `safeSigImg`, so `imgSrc` is always a bounded
 * `data:image/...` string. Every other field (`name`, `label`, `meta`) is
 * returned as RAW text and rendered as a JSX text child, where React performs
 * the escaping — so this never needs `dangerouslySetInnerHTML`. (The separate
 * `signatureMark` / `escapeHtml` primitives pre-escape for the rare caller that
 * builds an HTML string instead.)
 */
export function renderAgreementParts(args: {
  body: string | null | undefined;
  vars?: AgreementVars;
  contractorName: string;
  signature: SignatureInput;
  countersign: CountersignInput;
}): AgreementParts {
  const { body, vars, contractorName, signature, countersign } = args;
  const mergedText = mergeAgreement(body, vars);

  // Contractor — drawn image only when it passes safeSigImg, else raw name.
  const sigImg =
    signature && signature.signatureMethod === 'drawn' ? safeSigImg(signature.signatureData) : '';
  const sigDate = signature ? isoDate(signature.signedDate) || isoDate(signature.signedAt) : '';
  const sigIp =
    signature && signature.ipAddress != null && String(signature.ipAddress).trim() !== ''
      ? String(signature.ipAddress)
      : '';
  const contractor: AgreementSignatory = {
    ...(sigImg ? { imgSrc: sigImg } : { name: signature ? (signature.signedLegalName ?? '') : '' }),
    label: `Contractor — ${contractorName}`,
    meta: signature ? `Signed ${sigDate || '—'}${sigIp ? ` · IP ${sigIp}` : ''}` : 'Not yet signed',
  };

  // Countersign (Aaron Anderson E.H.S. LLC)
  const hasCs = !!countersign?.countersignedAt;
  const csImg =
    hasCs && countersign?.countersignMethod === 'drawn'
      ? safeSigImg(countersign.countersignData)
      : '';
  const csName = countersign?.countersignerName ? ` — ${countersign.countersignerName}` : '';
  const csIp =
    countersign &&
    countersign.countersignIp != null &&
    String(countersign.countersignIp).trim() !== ''
      ? String(countersign.countersignIp)
      : '';
  const countersignPart: AgreementSignatory = {
    ...(hasCs && csImg
      ? { imgSrc: csImg }
      : { name: hasCs ? (countersign?.countersignedName ?? '') : '' }),
    label: `For Aaron Anderson E.H.S. LLC${csName}`,
    meta: hasCs
      ? `Countersigned ${localeDateTime(countersign?.countersignedAt) || '—'}${csIp ? ` · IP ${csIp}` : ''}`
      : 'Not yet countersigned',
  };

  return { mergedText, contractor, countersign: countersignPart };
}
