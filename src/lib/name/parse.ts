/**
 * Split a single display name into Filipino-convention parts.
 *
 * Faithful port of the legacy app's `parseName` (app/index.html ~L3802): it
 * title-cases ALL-CAPS bank-statement input (preserving particles + the "Ma."
 * honorific), strips Jr./Sr./II–V suffixes onto the surname, detects compound
 * surnames by scanning for the first particle ("de la Cruz", "dela Cruz"), and
 * otherwise treats the single token immediately before the surname as the
 * maternal middle name.
 *
 * Used by the Wise "pull name into DB" and "link recipient" paths, where the
 * only available source is one combined name string.
 */

export interface ParsedName {
  first_name: string;
  middle_name: string;
  last_name: string;
}

const PARTICLES_LC = new Set([
  'de',
  'del',
  'dela',
  'la',
  'los',
  'las',
  'san',
  'santa',
  'santo',
  'y',
  'da',
  'do',
  'das',
  'dos',
]);

const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;
const ROMAN_SUFFIX_RE = /^(ii|iii|iv|v)$/i;
const MA_RE = /^ma\.?$/i;
// PH compound-first-name prefixes that bind to the next token as part of the
// FIRST name. Deliberately excludes "Juan" (almost always stands alone).
const FIRST_PREFIXES = new Set(['maria', 'ma', 'ma.', 'jose', 'mary', 'john']);

const EMPTY: ParsedName = { first_name: '', middle_name: '', last_name: '' };

function titleCaseToken(tok: string, i: number): string {
  const lc = tok.toLowerCase();
  // Particles mid-name stay lowercase (e.g. "Hazzan dela Cruz").
  if (i > 0 && PARTICLES_LC.has(lc)) return lc;
  // Honorific "Ma." keeps its period; bare "Ma" stays without one.
  if (MA_RE.test(tok)) return tok.includes('.') ? 'Ma.' : 'Ma';
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

function titleCase(str: string): string {
  return str
    .split(/\s+/)
    .map((tok, i) => titleCaseToken(tok, i))
    .join(' ');
}

function normaliseSuffix(suffix: string): string {
  if (ROMAN_SUFFIX_RE.test(suffix)) return suffix.toUpperCase();
  return `${suffix.charAt(0).toUpperCase()}${suffix.slice(1).toLowerCase().replace(/\.?$/, '.')}`;
}

export function parseName(raw: string | null | undefined): ParsedName {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ...EMPTY };

  // Title-case only if the source is entirely upper-case (bank-statement style).
  const hasLower = /[a-z]/.test(trimmed);
  const normalised = hasLower ? trimmed : titleCase(trimmed);

  const parts = normalised.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ...EMPTY };

  // Strip + capture a trailing suffix (Jr, Sr, II–V); requires ≥1 token before.
  let suffix = '';
  const tail = parts[parts.length - 1];
  if (parts.length >= 2 && tail !== undefined && SUFFIX_RE.test(tail)) {
    const popped = parts.pop();
    if (popped !== undefined) suffix = normaliseSuffix(popped);
  }

  if (parts.length === 1) {
    return { first_name: parts[0] ?? '', middle_name: '', last_name: suffix };
  }

  // Detect compound-surname start by scanning from the LEFT for the first
  // particle. Two-token particles ("de la/los/las") win, then single-token ones.
  let particleStartIdx = -1;
  for (let i = 1; i < parts.length - 1; i++) {
    const a = (parts[i] ?? '').toLowerCase();
    const b = (parts[i + 1] ?? '').toLowerCase();
    if (a === 'de' && (b === 'la' || b === 'los' || b === 'las') && i + 2 < parts.length) {
      particleStartIdx = i;
      break;
    }
  }
  if (particleStartIdx < 0) {
    for (let i = 1; i < parts.length - 1; i++) {
      if (PARTICLES_LC.has((parts[i] ?? '').toLowerCase())) {
        particleStartIdx = i;
        break;
      }
    }
  }

  let firstMiddleParts: string[];
  let lastParts: string[];
  if (particleStartIdx > 0) {
    firstMiddleParts = parts.slice(0, particleStartIdx);
    lastParts = parts.slice(particleStartIdx);
  } else {
    // No particle: conservative split — last token = surname, rest = given.
    lastParts = [parts[parts.length - 1] ?? ''];
    firstMiddleParts = parts.slice(0, -1);
  }

  // PH convention: the middle name is the single token immediately before the
  // surname; everything earlier is the (possibly multi-token) first name.
  let firstName: string;
  let middleName: string;
  if (firstMiddleParts.length === 1) {
    firstName = firstMiddleParts[0] ?? '';
    middleName = '';
  } else if (
    firstMiddleParts.length === 2 &&
    FIRST_PREFIXES.has((firstMiddleParts[0] ?? '').toLowerCase())
  ) {
    // Prefix rule on short names: "Ma. Luisa" → first="Ma. Luisa", no middle.
    firstName = firstMiddleParts.join(' ');
    middleName = '';
  } else if (firstMiddleParts.length === 2) {
    firstName = firstMiddleParts[0] ?? '';
    middleName = firstMiddleParts[1] ?? '';
  } else {
    firstName = firstMiddleParts.slice(0, -1).join(' ');
    middleName = firstMiddleParts[firstMiddleParts.length - 1] ?? '';
  }

  const lastName = suffix ? `${lastParts.join(' ')} ${suffix}` : lastParts.join(' ');
  return { first_name: firstName, middle_name: middleName, last_name: lastName };
}
