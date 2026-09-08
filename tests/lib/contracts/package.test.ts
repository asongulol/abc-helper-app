/**
 * Re-sign package + holds (docs/CONTRACT-CHANGE-WIZARD-PLAN.md decisions 8–10),
 * pinned to the owner's example: sent 8 Sep → 1–15 Sep pays, 16–30 Sep is held,
 * due 30 Sep.
 */

import { describe, expect, it } from 'vitest';
import {
  holdFor,
  type PackageStatus,
  packageOwedLines,
  packageStatusOf,
  packageWarning,
  resignDueOn,
} from '@/lib/contracts/package';

const pkg = (over: Partial<PackageStatus> = {}): PackageStatus => ({
  version: 3,
  dueOn: '2026-09-30',
  kinds: ['confidentiality_nda', 'baa'],
  outstanding: ['confidentiality_nda', 'baa'],
  contractSigned: true,
  ...over,
});

describe('resignDueOn', () => {
  it('is the last day of the period after the send period', () => {
    expect(resignDueOn('2026-09-08')).toBe('2026-09-30');
    expect(resignDueOn('2026-09-16')).toBe('2026-10-15');
    expect(resignDueOn('2026-12-20')).toBe('2027-01-15');
  });
});

describe('holdFor', () => {
  it('the send period pays; the following period is held while anything is unsigned', () => {
    expect(holdFor({ start: '2026-09-01', kind: 'regular' }, pkg())).toBeNull();
    expect(holdFor({ start: '2026-09-16', kind: 'regular' }, pkg())).toBe(
      'Re-sign NDA, BAA · due 2026-09-30',
    );
    expect(holdFor({ start: '2026-10-01', kind: 'regular' }, pkg())).toMatch(/^Re-sign/);
  });

  it('nothing outstanding, no package, or an off-cycle batch: no hold', () => {
    expect(holdFor({ start: '2026-09-16', kind: 'regular' }, pkg({ outstanding: [] }))).toBeNull();
    expect(holdFor({ start: '2026-09-16', kind: 'regular' }, null)).toBeNull();
    expect(holdFor({ start: '2026-09-16', kind: 'off_cycle' }, pkg())).toBeNull();
  });
});

describe('packageStatusOf', () => {
  const v = (over: Partial<Parameters<typeof packageStatusOf>[0][number]> = {}) => ({
    version: 2,
    status: 'sent' as const,
    resignKinds: ['baa', 'confidentiality_nda'] as const,
    resignDueOn: '2026-09-30',
    sentAt: '2026-09-08T10:00:00Z',
    ...over,
  });

  it('newest asking version wins; outstanding keeps signing order and ignores superseded kinds', () => {
    const s = packageStatusOf(
      [v({ version: 2, status: 'active' }), v({ version: 3, resignKinds: ['non_compete', 'baa'] })],
      new Set(['ic_agreement', 'confidentiality_nda']),
    );
    expect(s).toEqual({
      version: 3,
      dueOn: '2026-09-30',
      kinds: ['non_compete', 'baa'],
      outstanding: ['non_compete', 'baa'],
      contractSigned: false,
    });
    expect(packageStatusOf([v({ status: 'signed' })], new Set(['baa']))).toMatchObject({
      outstanding: ['confidentiality_nda'],
      contractSigned: true,
    });
  });

  it('a draft, a void, or a version with no package is nothing', () => {
    expect(packageStatusOf([v({ status: 'draft' })], new Set())).toBeNull();
    expect(packageStatusOf([v({ status: 'void' })], new Set())).toBeNull();
    expect(packageStatusOf([v({ resignKinds: [] })], new Set())).toBeNull();
  });
});

describe('warning and owed lines', () => {
  it('name the date and the consequence', () => {
    expect(packageWarning('2026-09-30')).toBe(
      'Sign by Sep 30, 2026. If it is not done, your pay for Sep 16, 2026 – Sep 30, 2026 will be delayed until it is.',
    );
    expect(packageOwedLines(pkg({ outstanding: ['baa'] }))).toEqual([
      'Sign your Business Associate Agreement in the portal by Sep 30, 2026',
    ]);
  });
});
