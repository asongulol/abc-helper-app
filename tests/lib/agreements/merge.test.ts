import {
  type AgreementVars,
  escapeHtml,
  mergeAgreement,
  monthlyFromPeriod,
  renderAgreementParts,
  safeSigImg,
  signatureMark,
} from '@/lib/agreements/merge';
import { describe, expect, it } from 'vitest';

// A small valid 1x1 PNG data-URI (base64 charset only).
const VALID_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const VALID_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
const VALID_JPG = 'data:image/jpg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD=';
const VALID_WEBP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAQAcJaQAA3AA=';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;');
  });
  it('null/undefined → empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('monthlyFromPeriod (semi-monthly rate × 2)', () => {
  it('doubles a numeric per-period rate and locale-formats it', () => {
    expect(monthlyFromPeriod('25000')).toBe('50,000');
    expect(monthlyFromPeriod(12500)).toBe('25,000');
  });
  it('strips currency symbols / commas before parsing', () => {
    expect(monthlyFromPeriod('₱15,000')).toBe('30,000');
    expect(monthlyFromPeriod('$1,234.50')).toBe('2,469');
  });
  it('keeps cents when present', () => {
    expect(monthlyFromPeriod('100.25')).toBe('200.5');
  });
  it('empty string for unparseable / non-positive', () => {
    expect(monthlyFromPeriod('')).toBe('');
    expect(monthlyFromPeriod(null)).toBe('');
    expect(monthlyFromPeriod('abc')).toBe('');
    expect(monthlyFromPeriod('0')).toBe('');
  });

  it('legacy quirk: a minus sign is stripped (non-[0-9.]), so "-50" → "100"', () => {
    expect(monthlyFromPeriod('-50')).toBe('100');
  });
});

describe('mergeAgreement — token parity + defaults', () => {
  it('replaces every known token from supplied vars', () => {
    const body =
      '{{contractor_name}} / {{rate}} / {{monthly_rate}} / {{company_name}} / {{client_name}} / {{employer_name}} / {{start_date}} / {{position}} / {{contractor_address}} / {{countersigner_name}} / {{today}}';
    const vars: AgreementVars = {
      contractor_name: 'Jane Doe',
      rate: '₱25,000',
      monthly_rate: '50,000',
      company_name: 'Acme Co',
      employer_name: 'Employer LLC',
      start_date: '2026-01-01',
      position: 'Engineer',
      contractor_address: '123 Main St',
      countersigner_name: 'Owner',
      today: '2026-06-14',
    };
    const out = mergeAgreement(body, vars);
    expect(out).toContain('Jane Doe');
    expect(out).toContain('₱25,000');
    expect(out).toContain('50,000');
    expect(out).toContain('Acme Co'); // both company_name + client_name map to it
    expect(out).toContain('Employer LLC');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('Engineer');
    expect(out).toContain('123 Main St');
    expect(out).toContain('Owner');
    expect(out).toContain('2026-06-14');
    // client_name resolved to company_name
    expect(out.split('Acme Co').length - 1).toBe(2);
  });

  it('applies legacy defaults for missing tokens', () => {
    const out = mergeAgreement('{{rate}} {{employer_name}} {{position}}', {});
    expect(out).toContain('________'); // rate default
    expect(out).toContain('Aaron Anderson E.H.S. LLC'); // employer_name default
  });

  it('leaves unknown tokens untouched', () => {
    expect(mergeAgreement('{{not_a_token}}', {})).toBe('{{not_a_token}}');
  });

  it('appends addendum when set and not inlined', () => {
    const out = mergeAgreement('Body text', { addendum: 'EXTRA SCOPE' });
    expect(out).toBe('Body text\n\nEXTRA SCOPE');
  });

  it('inlines addendum when the token is present (no duplicate append)', () => {
    const out = mergeAgreement('Body {{addendum}}', { addendum: 'EXTRA' });
    expect(out).toBe('Body EXTRA');
  });

  it('auto-appends engagement basis + DST clause when type/schedule set but not inlined', () => {
    const out = mergeAgreement('Body', {
      employment_type: 'full_time',
      schedule: '09:00–18:00 (ET), Mon–Fri',
    });
    expect(out).toContain('Engagement: Full-time (40 hours/week).');
    expect(out).toContain('Work schedule: 09:00–18:00 (ET), Mon–Fri.');
    expect(out).toContain('daylight saving time');
    expect(out).toContain('Philippines does not change its clocks');
  });

  it('part-time defaults to 20 hours/week in the engagement phrase', () => {
    const out = mergeAgreement('Body', { employment_type: 'part_time' });
    expect(out).toContain('Engagement: Part-time (20 hours/week).');
    // no schedule → no DST clause
    expect(out).not.toContain('daylight saving time');
  });

  it('explicit hours_per_week overrides the type default', () => {
    const out = mergeAgreement('Body', { employment_type: 'full_time', hours_per_week: 32 });
    expect(out).toContain('Engagement: Full-time (32 hours/week).');
  });

  it('does NOT auto-append when those tokens are placed inline in the body', () => {
    const out = mergeAgreement('Type: {{employment_type}}', {
      employment_type: 'full_time',
      schedule: 'X',
    });
    expect(out).toBe('Type: Full-time (40 hours/week)');
    expect(out).not.toContain('Engagement:');
  });
});

describe('safeSigImg — the stored-XSS boundary', () => {
  it('accepts valid png / jpeg / jpg / webp base64 data-URIs', () => {
    expect(safeSigImg(VALID_PNG)).toBe(VALID_PNG);
    expect(safeSigImg(VALID_JPEG)).toBe(VALID_JPEG);
    expect(safeSigImg(VALID_JPG)).toBe(VALID_JPG);
    expect(safeSigImg(VALID_WEBP)).toBe(VALID_WEBP);
  });

  it('REJECTS javascript: URIs', () => {
    expect(safeSigImg('javascript:alert(1)')).toBe('');
  });

  it('REJECTS data:text/html payloads', () => {
    expect(safeSigImg('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
  });

  it('REJECTS a payload containing a quote (attribute breakout attempt)', () => {
    expect(safeSigImg('data:image/png;base64,abc"onerror=alert(1)')).toBe('');
    expect(safeSigImg("data:image/png;base64,abc'onerror=alert(1)")).toBe('');
  });

  it('REJECTS a payload containing < (tag breakout attempt)', () => {
    expect(safeSigImg('data:image/png;base64,abc<script>')).toBe('');
  });

  it('REJECTS unsupported image subtypes (svg, gif)', () => {
    expect(safeSigImg('data:image/svg+xml;base64,PHN2Zz4=')).toBe('');
    expect(safeSigImg('data:image/gif;base64,R0lGOD==')).toBe('');
  });

  it('REJECTS oversized payloads (> ~1MB)', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(1_500_000)}`;
    expect(safeSigImg(oversized)).toBe('');
  });

  it('REJECTS garbage / non-data-URI strings and null', () => {
    expect(safeSigImg('not a data uri')).toBe('');
    expect(safeSigImg('')).toBe('');
    expect(safeSigImg(null)).toBe('');
    expect(safeSigImg(undefined)).toBe('');
  });
});

describe('signatureMark — falls back to escaped name on malicious data', () => {
  it('drawn + valid data-URI → image source', () => {
    expect(signatureMark({ method: 'drawn', data: VALID_PNG, name: 'Jane' })).toEqual({
      imgSrc: VALID_PNG,
    });
  });

  it('typed → escaped name even if data looks like an image', () => {
    expect(signatureMark({ method: 'typed', data: VALID_PNG, name: 'Jane Doe' })).toEqual({
      name: 'Jane Doe',
    });
  });

  it('drawn + MALICIOUS data → escaped name, never the payload', () => {
    const mark = signatureMark({
      method: 'drawn',
      data: 'javascript:alert(document.cookie)',
      name: '<img src=x onerror=alert(1)>',
    });
    expect('imgSrc' in mark).toBe(false);
    if ('name' in mark) {
      expect(mark.name).toBe('&lt;img src=x onerror=alert(1)&gt;');
      expect(mark.name).not.toContain('<');
    }
  });
});

describe('renderAgreementParts — structured, escaped render', () => {
  it('renders contractor + countersign with safe image and escaped meta', () => {
    const parts = renderAgreementParts({
      body: 'Hello {{contractor_name}}',
      vars: { contractor_name: 'Jane Doe' },
      contractorName: 'Jane Doe',
      signature: {
        signatureMethod: 'drawn',
        signatureData: VALID_PNG,
        signedLegalName: 'Jane Doe',
        signedDate: '2026-01-04',
        ipAddress: '1.2.3.4',
      },
      countersign: {
        countersignMethod: 'typed',
        countersignedName: 'Owner',
        countersignerName: 'Owner Name',
        countersignedAt: '2026-01-05T10:00:00Z',
        countersignIp: '5.6.7.8',
      },
    });
    expect(parts.mergedText).toContain('Hello Jane Doe');
    expect(parts.contractor.imgSrc).toBe(VALID_PNG);
    expect(parts.contractor.label).toBe('Contractor — Jane Doe');
    expect(parts.contractor.meta).toContain('Signed 2026-01-04');
    expect(parts.contractor.meta).toContain('IP 1.2.3.4');
    expect(parts.countersign.name).toBe('Owner'); // typed → raw name (JSX escapes at render)
    expect(parts.countersign.label).toBe('For Aaron Anderson E.H.S. LLC — Owner Name');
    expect(parts.countersign.meta).toContain('Countersigned');
    expect(parts.countersign.meta).toContain('IP 5.6.7.8');
  });

  it('a MALICIOUS drawn-signature data-URI never becomes an image (gated by safeSigImg)', () => {
    const parts = renderAgreementParts({
      body: 'Body',
      contractorName: 'Jane',
      signature: {
        signatureMethod: 'drawn',
        // not a valid image data-URI → rejected, falls back to the name
        signatureData: 'javascript:alert(document.cookie)',
        signedLegalName: 'Jane Doe',
        signedDate: '2026-01-04',
      },
      countersign: null,
    });
    expect(parts.contractor.imgSrc).toBeUndefined();
    expect(parts.contractor.name).toBe('Jane Doe');
  });

  it('raw name/label flow through verbatim — React (JSX) does the escaping at render', () => {
    // The selector returns RAW text; the route renders it as a JSX text child,
    // so React escapes it. We assert the raw value is preserved (not pre-escaped
    // and not stripped) so JSX produces correct, non-double-escaped output.
    const parts = renderAgreementParts({
      body: 'Body',
      contractorName: '<script>alert(1)</script>',
      signature: {
        signatureMethod: 'typed',
        signatureData: null,
        signedLegalName: '"><img src=x onerror=alert(1)>',
        signedDate: '2026-01-04',
      },
      countersign: null,
    });
    expect(parts.contractor.name).toBe('"><img src=x onerror=alert(1)>');
    expect(parts.contractor.label).toBe('Contractor — <script>alert(1)</script>');
    // safeSigImg still applies — a typed signature is never an image.
    expect(parts.contractor.imgSrc).toBeUndefined();
  });

  it('escapeHtml/signatureMark remain the escaping primitives for HTML-string callers', () => {
    // Independent of the JSX path: the escaping primitives still neutralise markup.
    const mark = signatureMark({
      method: 'typed',
      data: null,
      name: '<img src=x onerror=alert(1)>',
    });
    expect('name' in mark && mark.name).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('unsigned / not-countersigned states', () => {
    const parts = renderAgreementParts({
      body: 'Body',
      contractorName: 'Jane',
      signature: null,
      countersign: null,
    });
    expect(parts.contractor.meta).toBe('Not yet signed');
    expect(parts.countersign.meta).toBe('Not yet countersigned');
    expect(parts.contractor.name).toBe('');
  });
});
