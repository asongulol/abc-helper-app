'use client';

import { type CSSProperties, type InputHTMLAttributes, useEffect, useState } from 'react';

interface Country {
  code: string;
  cc: string;
  name: string;
  flag: string;
  ex: string;
}

/** ISO-3166 alpha-2 → emoji flag (regional-indicator code points). */
const flagOf = (iso: string): string =>
  iso.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0)));

/** US + PH pinned to the top; everyone else sorted by name. */
const PINNED: ReadonlyArray<Omit<Country, 'flag'>> = [
  { code: 'US', cc: '+1', name: 'US / Canada', ex: '(212) 555-0100' },
  { code: 'PH', cc: '+63', name: 'Philippines', ex: '917-123-4567' },
];

const REST_RAW: ReadonlyArray<readonly [string, string, string]> = [
  ['AF', '+93', 'Afghanistan'],
  ['AL', '+355', 'Albania'],
  ['DZ', '+213', 'Algeria'],
  ['AD', '+376', 'Andorra'],
  ['AO', '+244', 'Angola'],
  ['AG', '+1', 'Antigua & Barbuda'],
  ['AR', '+54', 'Argentina'],
  ['AM', '+374', 'Armenia'],
  ['AW', '+297', 'Aruba'],
  ['AU', '+61', 'Australia'],
  ['AT', '+43', 'Austria'],
  ['AZ', '+994', 'Azerbaijan'],
  ['BS', '+1', 'Bahamas'],
  ['BH', '+973', 'Bahrain'],
  ['BD', '+880', 'Bangladesh'],
  ['BB', '+1', 'Barbados'],
  ['BY', '+375', 'Belarus'],
  ['BE', '+32', 'Belgium'],
  ['BZ', '+501', 'Belize'],
  ['BJ', '+229', 'Benin'],
  ['BT', '+975', 'Bhutan'],
  ['BO', '+591', 'Bolivia'],
  ['BA', '+387', 'Bosnia & Herzegovina'],
  ['BW', '+267', 'Botswana'],
  ['BR', '+55', 'Brazil'],
  ['BN', '+673', 'Brunei'],
  ['BG', '+359', 'Bulgaria'],
  ['BF', '+226', 'Burkina Faso'],
  ['BI', '+257', 'Burundi'],
  ['KH', '+855', 'Cambodia'],
  ['CM', '+237', 'Cameroon'],
  ['CV', '+238', 'Cape Verde'],
  ['CF', '+236', 'Central African Republic'],
  ['TD', '+235', 'Chad'],
  ['CL', '+56', 'Chile'],
  ['CN', '+86', 'China'],
  ['CO', '+57', 'Colombia'],
  ['KM', '+269', 'Comoros'],
  ['CG', '+242', 'Congo - Brazzaville'],
  ['CD', '+243', 'Congo - Kinshasa'],
  ['CR', '+506', 'Costa Rica'],
  ['CI', '+225', "Côte d'Ivoire"],
  ['HR', '+385', 'Croatia'],
  ['CU', '+53', 'Cuba'],
  ['CY', '+357', 'Cyprus'],
  ['CZ', '+420', 'Czechia'],
  ['DK', '+45', 'Denmark'],
  ['DJ', '+253', 'Djibouti'],
  ['DM', '+1', 'Dominica'],
  ['DO', '+1', 'Dominican Republic'],
  ['EC', '+593', 'Ecuador'],
  ['EG', '+20', 'Egypt'],
  ['SV', '+503', 'El Salvador'],
  ['GQ', '+240', 'Equatorial Guinea'],
  ['ER', '+291', 'Eritrea'],
  ['EE', '+372', 'Estonia'],
  ['SZ', '+268', 'Eswatini'],
  ['ET', '+251', 'Ethiopia'],
  ['FJ', '+679', 'Fiji'],
  ['FI', '+358', 'Finland'],
  ['FR', '+33', 'France'],
  ['GA', '+241', 'Gabon'],
  ['GM', '+220', 'Gambia'],
  ['GE', '+995', 'Georgia'],
  ['DE', '+49', 'Germany'],
  ['GH', '+233', 'Ghana'],
  ['GR', '+30', 'Greece'],
  ['GD', '+1', 'Grenada'],
  ['GT', '+502', 'Guatemala'],
  ['GN', '+224', 'Guinea'],
  ['GW', '+245', 'Guinea-Bissau'],
  ['GY', '+592', 'Guyana'],
  ['HT', '+509', 'Haiti'],
  ['HN', '+504', 'Honduras'],
  ['HK', '+852', 'Hong Kong'],
  ['HU', '+36', 'Hungary'],
  ['IS', '+354', 'Iceland'],
  ['IN', '+91', 'India'],
  ['ID', '+62', 'Indonesia'],
  ['IR', '+98', 'Iran'],
  ['IQ', '+964', 'Iraq'],
  ['IE', '+353', 'Ireland'],
  ['IL', '+972', 'Israel'],
  ['IT', '+39', 'Italy'],
  ['JM', '+1', 'Jamaica'],
  ['JP', '+81', 'Japan'],
  ['JO', '+962', 'Jordan'],
  ['KZ', '+7', 'Kazakhstan'],
  ['KE', '+254', 'Kenya'],
  ['KI', '+686', 'Kiribati'],
  ['KW', '+965', 'Kuwait'],
  ['KG', '+996', 'Kyrgyzstan'],
  ['LA', '+856', 'Laos'],
  ['LV', '+371', 'Latvia'],
  ['LB', '+961', 'Lebanon'],
  ['LS', '+266', 'Lesotho'],
  ['LR', '+231', 'Liberia'],
  ['LY', '+218', 'Libya'],
  ['LI', '+423', 'Liechtenstein'],
  ['LT', '+370', 'Lithuania'],
  ['LU', '+352', 'Luxembourg'],
  ['MO', '+853', 'Macau'],
  ['MG', '+261', 'Madagascar'],
  ['MW', '+265', 'Malawi'],
  ['MY', '+60', 'Malaysia'],
  ['MV', '+960', 'Maldives'],
  ['ML', '+223', 'Mali'],
  ['MT', '+356', 'Malta'],
  ['MH', '+692', 'Marshall Islands'],
  ['MR', '+222', 'Mauritania'],
  ['MU', '+230', 'Mauritius'],
  ['MX', '+52', 'Mexico'],
  ['FM', '+691', 'Micronesia'],
  ['MD', '+373', 'Moldova'],
  ['MC', '+377', 'Monaco'],
  ['MN', '+976', 'Mongolia'],
  ['ME', '+382', 'Montenegro'],
  ['MA', '+212', 'Morocco'],
  ['MZ', '+258', 'Mozambique'],
  ['MM', '+95', 'Myanmar (Burma)'],
  ['NA', '+264', 'Namibia'],
  ['NR', '+674', 'Nauru'],
  ['NP', '+977', 'Nepal'],
  ['NL', '+31', 'Netherlands'],
  ['NZ', '+64', 'New Zealand'],
  ['NI', '+505', 'Nicaragua'],
  ['NE', '+227', 'Niger'],
  ['NG', '+234', 'Nigeria'],
  ['KP', '+850', 'North Korea'],
  ['MK', '+389', 'North Macedonia'],
  ['NO', '+47', 'Norway'],
  ['OM', '+968', 'Oman'],
  ['PK', '+92', 'Pakistan'],
  ['PW', '+680', 'Palau'],
  ['PS', '+970', 'Palestine'],
  ['PA', '+507', 'Panama'],
  ['PG', '+675', 'Papua New Guinea'],
  ['PY', '+595', 'Paraguay'],
  ['PE', '+51', 'Peru'],
  ['PL', '+48', 'Poland'],
  ['PT', '+351', 'Portugal'],
  ['QA', '+974', 'Qatar'],
  ['RO', '+40', 'Romania'],
  ['RU', '+7', 'Russia'],
  ['RW', '+250', 'Rwanda'],
  ['KN', '+1', 'St. Kitts & Nevis'],
  ['LC', '+1', 'St. Lucia'],
  ['VC', '+1', 'St. Vincent & Grenadines'],
  ['WS', '+685', 'Samoa'],
  ['SM', '+378', 'San Marino'],
  ['ST', '+239', 'São Tomé & Príncipe'],
  ['SA', '+966', 'Saudi Arabia'],
  ['SN', '+221', 'Senegal'],
  ['RS', '+381', 'Serbia'],
  ['SC', '+248', 'Seychelles'],
  ['SL', '+232', 'Sierra Leone'],
  ['SG', '+65', 'Singapore'],
  ['SK', '+421', 'Slovakia'],
  ['SI', '+386', 'Slovenia'],
  ['SB', '+677', 'Solomon Islands'],
  ['SO', '+252', 'Somalia'],
  ['ZA', '+27', 'South Africa'],
  ['KR', '+82', 'South Korea'],
  ['SS', '+211', 'South Sudan'],
  ['ES', '+34', 'Spain'],
  ['LK', '+94', 'Sri Lanka'],
  ['SD', '+249', 'Sudan'],
  ['SR', '+597', 'Suriname'],
  ['SE', '+46', 'Sweden'],
  ['CH', '+41', 'Switzerland'],
  ['SY', '+963', 'Syria'],
  ['TW', '+886', 'Taiwan'],
  ['TJ', '+992', 'Tajikistan'],
  ['TZ', '+255', 'Tanzania'],
  ['TH', '+66', 'Thailand'],
  ['TL', '+670', 'Timor-Leste'],
  ['TG', '+228', 'Togo'],
  ['TO', '+676', 'Tonga'],
  ['TT', '+1', 'Trinidad & Tobago'],
  ['TN', '+216', 'Tunisia'],
  ['TR', '+90', 'Turkey'],
  ['TM', '+993', 'Turkmenistan'],
  ['TV', '+688', 'Tuvalu'],
  ['UG', '+256', 'Uganda'],
  ['UA', '+380', 'Ukraine'],
  ['AE', '+971', 'United Arab Emirates'],
  ['GB', '+44', 'United Kingdom'],
  ['UY', '+598', 'Uruguay'],
  ['UZ', '+998', 'Uzbekistan'],
  ['VU', '+678', 'Vanuatu'],
  ['VA', '+379', 'Vatican City'],
  ['VE', '+58', 'Venezuela'],
  ['VN', '+84', 'Vietnam'],
  ['YE', '+967', 'Yemen'],
  ['ZM', '+260', 'Zambia'],
  ['ZW', '+263', 'Zimbabwe'],
];

/** Full legacy country list (PINNED first, REST sorted by name), with flag emoji. */
const COUNTRIES: ReadonlyArray<Country> = [
  ...PINNED,
  ...REST_RAW.map(([code, cc, name]) => ({ code, cc, name, ex: '' })).sort((a, b) =>
    a.name.localeCompare(b.name),
  ),
].map((c) => ({ ...c, flag: flagOf(c.code) }));

const countryFor = (code: string): Country =>
  // biome-ignore lint/style/noNonNullAssertion: COUNTRIES is a non-empty literal (US at index 0)
  COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0]!;

/**
 * Group national digits per country style (progressive, for live typing). US & PH
 * use local grouping; every other country keeps raw digits (E.164 caps total at 15).
 * US: "(AAA) BBB-CCCC"  ·  PH: "AAA-BBB-CCCC".
 */
function groupNational(code: string, raw: string): string {
  if (code === 'US' || code === 'PH') {
    const d = (raw ?? '').replace(/\D/g, '').slice(0, 10);
    if (!d) return '';
    const a = d.slice(0, 3);
    const b = d.slice(3, 6);
    const c = d.slice(6, 10);
    if (code === 'PH') return [a, b, c].filter(Boolean).join('-');
    let out = `(${a}`;
    if (d.length > 3) out += `) ${b}`;
    if (d.length > 6) out += `-${c}`;
    return out;
  }
  return (raw ?? '').replace(/\D/g, '').slice(0, 15);
}

/** Combine country + national number into the stored/displayed canonical string. */
function buildPhone(code: string, national: string): string {
  const g = groupNational(code, national);
  return g ? `${countryFor(code).cc} ${g}` : '';
}

/**
 * Parse a stored phone string into {code, national}. Detects PH/US local forms
 * first (+63/+1, 63+10, 0+10, 1+10), then matches the longest dial-code prefix of
 * any picker country; otherwise falls back to `def`.
 */
function parsePhone(
  value: string | null | undefined,
  def: string,
): {
  code: string;
  national: string;
} {
  const s = String(value ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return { code: def || 'PH', national: '' };
  if (s.startsWith('+63') || (digits.startsWith('63') && digits.length === 12))
    return { code: 'PH', national: digits.replace(/^63/, '').slice(0, 10) };
  if (digits.startsWith('0') && digits.length === 11)
    return { code: 'PH', national: digits.slice(1, 11) };
  if (s.startsWith('+1') || (digits.startsWith('1') && digits.length === 11))
    return { code: 'US', national: digits.replace(/^1/, '').slice(0, 10) };
  if (s.startsWith('+')) {
    let best: { code: string; len: number } | null = null;
    for (const c of COUNTRIES) {
      const d = c.cc.replace(/\D/g, '');
      if (d && digits.startsWith(d) && (!best || d.length > best.len))
        best = { code: c.code, len: d.length };
    }
    if (best) return { code: best.code, national: digits.slice(best.len).slice(0, 15) };
  }
  return { code: def || 'PH', national: digits.slice(-10) };
}

/**
 * Pretty-print any stored phone value (read-only display + on-save normalization).
 * US → "+1 (AAA) BBB-CCCC", PH → "+63 AAA-BBB-CCCC", others → "+CC digits".
 * Incomplete US/PH numbers are returned unchanged so a half-typed value is never mangled.
 */
export function formatPhone(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const { code, national } = parsePhone(s, '');
  if (!national) return s;
  if ((code === 'US' || code === 'PH') && national.length !== 10) return s;
  return buildPhone(code, national);
}

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>;

export interface PhoneInputProps extends NativeInputProps {
  value: string;
  /** Emits the canonical string (e.g. "+63 917-123-4567"). */
  onChange: (value: string) => void;
  /** Used only when the stored value has no explicit country code. */
  defaultCountry?: string | undefined;
  /** Wrapper style override. */
  style?: CSSProperties | undefined;
  /** National-number input style override. */
  inputStyle?: CSSProperties | undefined;
  placeholder?: string | undefined;
}

/**
 * Phone field with a country-code picker. Controlled by `value` (the full stored
 * string e.g. "+63 917-123-4567"); emits the same canonical string via onChange.
 * Live edits stay raw (no cursor jank); formats on blur and on country switch.
 * Faithful port of the legacy PhoneInput (portal/index.html).
 */
export const PhoneInput = ({
  value,
  onChange,
  defaultCountry = 'PH',
  style,
  inputStyle,
  placeholder,
  ...rest
}: PhoneInputProps) => {
  const p0 = parsePhone(value, defaultCountry);
  const [country, setCountry] = useState<string>(p0.code);
  const [nat, setNat] = useState(() => groupNational(p0.code, p0.national));

  // Re-sync if the value prop changes from outside (record load) and differs
  // from what we'd emit — without clobbering in-progress typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the resync; country/nat intentionally excluded
  useEffect(() => {
    const emitted = buildPhone(country, nat);
    if (String(value ?? '') !== emitted) {
      const p = parsePhone(value, defaultCountry);
      setCountry(p.code);
      setNat(groupNational(p.code, p.national));
    }
    // value drives the resync; country/nat are intentionally not deps.
  }, [value]);

  const emit = (code: string, text: string) => onChange(buildPhone(code, text));

  return (
    <div style={{ display: 'flex', gap: 6, width: '100%', ...style }}>
      <select
        aria-label="Country code"
        value={country}
        style={{ flex: '0 0 auto', width: 96, padding: '0 4px' }}
        onChange={(e) => {
          const c = e.target.value;
          setCountry(c);
          setNat((n) => groupNational(c, n));
          emit(c, nat);
        }}
      >
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code} title={c.name}>
            {c.flag} {c.cc} {c.name}
          </option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="tel"
        value={nat}
        placeholder={placeholder ?? countryFor(country).ex}
        style={{ flex: 1, minWidth: 0, ...inputStyle }}
        onChange={(e) => {
          setNat(e.target.value);
          emit(country, e.target.value);
        }}
        onBlur={(e) => {
          const g = groupNational(country, e.target.value);
          setNat(g);
          emit(country, g);
        }}
        {...rest}
      />
    </div>
  );
};
