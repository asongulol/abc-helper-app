/**
 * Re-sign package and pay holds — the pure half
 * (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decisions 8–11). No DB, no React:
 * `fetchOutstandingPackages` (src/db/queries/contracts.ts) feeds
 * `packageStatusOf`, and Calculate stamps whatever `holdFor` says.
 */

import type { Database } from '@/db/types';
import { nextPeriod, periodFor } from '@/lib/dates/periods';
import { fmtDate } from '@/lib/format';

export type AgreementKind = Database['public']['Enums']['agreement_kind'];

/** The agreements a package may ask to re-sign, in portal signing order. */
export const PACKAGE_KINDS = [
  'non_compete',
  'confidentiality_nda',
  'baa',
] as const satisfies readonly AgreementKind[];
export type PackageKind = (typeof PACKAGE_KINDS)[number];

export const PACKAGE_LABEL: Record<PackageKind, string> = {
  non_compete: 'Non-Compete',
  confidentiality_nda: 'NDA',
  baa: 'BAA',
};
export const PACKAGE_TITLE: Record<PackageKind, string> = {
  non_compete: 'Non-Compete Agreement',
  confidentiality_nda: 'Confidentiality / NDA',
  baa: 'Business Associate Agreement',
};

export const packageLabels = (kinds: readonly AgreementKind[]): string =>
  kinds.map((k) => (PACKAGE_LABEL as Record<string, string>)[k] ?? k).join(', ');

/**
 * Decision 9: the last day of the period AFTER the one containing the send
 * date. Sent 8 Sep → 1–15 Sep pays regardless, 16–30 Sep is the held period,
 * due 30 Sep.
 */
export const resignDueOn = (sentOn: string): string => nextPeriod(sentOn).end;

export type PackageVersion = {
  version: number;
  status: Database['public']['Enums']['contract_version_status'];
  resignKinds: readonly AgreementKind[];
  resignDueOn: string | null;
  sentAt: string | null;
};

export type PackageStatus = {
  version: number;
  dueOn: string;
  /** What the version asked for, in signing order. */
  kinds: PackageKind[];
  /** Still unsigned, in signing order. */
  outstanding: PackageKind[];
  /** The contract itself is signed (or already of record) — agreements may follow (decision 8). */
  contractSigned: boolean;
};

/**
 * The package a contractor is working through: the newest sent / signed /
 * active version that asked for one, judged against the kinds currently
 * signed (a superseded signature does not count). Null when no version asked
 * for anything. ponytail: an older version's unfinished package is forgotten
 * once a newer one asks for its own — the newer send superseded the same
 * signatures anyway.
 */
export const packageStatusOf = (
  versions: readonly PackageVersion[],
  signedKinds: ReadonlySet<AgreementKind>,
): PackageStatus | null => {
  const v = versions
    .filter(
      (x) =>
        (x.status === 'sent' || x.status === 'signed' || x.status === 'active') &&
        x.resignKinds.length > 0 &&
        x.sentAt,
    )
    .sort((a, b) => b.version - a.version)[0];
  if (!v) return null;
  const kinds = PACKAGE_KINDS.filter((k) => v.resignKinds.includes(k));
  return {
    version: v.version,
    dueOn: v.resignDueOn ?? resignDueOn((v.sentAt as string).slice(0, 10)),
    kinds,
    outstanding: kinds.filter((k) => !signedKinds.has(k)),
    contractSigned: v.status !== 'sent',
  };
};

/**
 * Why a draft in `period` is withheld, or null (decision 9). The period
 * containing the send date always pays; from the period ending on the due
 * date on, every regular period is held while anything is unsigned.
 */
export const holdFor = (
  period: { start: string; kind: string | null },
  pkg: PackageStatus | null,
): string | null => {
  if (!pkg || pkg.outstanding.length === 0 || period.kind === 'off_cycle') return null;
  if (period.start < periodFor(pkg.dueOn).start) return null;
  return `Re-sign ${packageLabels(pkg.outstanding)} · due ${pkg.dueOn}`;
};

/** The contractor-facing warning (decision 10): the date and the consequence. */
export const packageWarning = (dueOn: string): string => {
  const held = periodFor(dueOn);
  return `Sign by ${fmtDate(dueOn)}. If it is not done, your pay for ${fmtDate(held.start)} – ${fmtDate(held.end)} will be delayed until it is.`;
};

/** One owed line per unsigned agreement — the Remind email and the Current team row. */
export const packageOwedLines = (pkg: PackageStatus): string[] =>
  pkg.outstanding.map(
    (k) => `Sign your ${PACKAGE_TITLE[k]} in the portal by ${fmtDate(pkg.dueOn)}`,
  );
