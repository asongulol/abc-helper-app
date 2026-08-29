/**
 * Default motto suggestions for the portal profile, in the language of the
 * contractor's area (matched from the free-text ph_address). PH-wide default
 * is Tagalog; keyword sets cover the major regional languages our contractors
 * actually live in. Suggestions are just prefills — the contractor can type
 * anything.
 */

export type MottoLanguage = 'tagalog' | 'cebuano' | 'hiligaynon' | 'ilocano';

export const MOTTO_SUGGESTIONS: Record<MottoLanguage, string[]> = {
  tagalog: [
    'Kapag may tiyaga, may nilaga.',
    'Habang may buhay, may pag-asa.',
    'Kung may tinanim, may aanihin.',
  ],
  cebuano: ['Padayon lang!', 'Ang kakugi dalan sa kalampusan.', 'Adunay paglaum kanunay.'],
  hiligaynon: [
    'Padayon lang sa kabuhi.',
    'Ang kapisan dalan sa kadalag-an.',
    'May paglaum gihapon.',
  ],
  ilocano: ['Ti gaget, tulbek ti balligi.', 'No adda anus, adda mabalin.', 'Agtultuloy latta.'],
};

// Checked in order — 'cagayan de oro' (Cebuano) must win before any broader
// 'cagayan' (Ilocano-area) match.
const AREA_KEYWORDS: ReadonlyArray<readonly [MottoLanguage, string[]]> = [
  [
    'cebuano',
    [
      'cebu',
      'davao',
      'cagayan de oro',
      'bohol',
      'dumaguete',
      'misamis',
      'bukidnon',
      'iligan',
      'butuan',
      'surigao',
      'general santos',
      'mandaue',
      'lapu-lapu',
    ],
  ],
  [
    'hiligaynon',
    [
      'iloilo',
      'bacolod',
      'negros occidental',
      'capiz',
      'roxas',
      'antique',
      'guimaras',
      'kabankalan',
    ],
  ],
  ['ilocano', ['ilocos', 'vigan', 'laoag', 'la union', 'abra', 'tuguegarao']],
];

export const mottoLanguageFor = (phAddress: string | null): MottoLanguage => {
  const addr = (phAddress ?? '').toLowerCase();
  if (addr) {
    for (const [lang, words] of AREA_KEYWORDS) {
      if (words.some((w) => addr.includes(w))) return lang;
    }
  }
  return 'tagalog';
};

export const suggestMottos = (phAddress: string | null): string[] =>
  MOTTO_SUGGESTIONS[mottoLanguageFor(phAddress)];
