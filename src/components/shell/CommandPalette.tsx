'use client';

import { Modal } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavItem } from './nav';

export interface CommandPaletteProps {
  /** Flat list of navigable sections (label/href/icon), sourced from NAV_GROUPS. */
  sections: ReadonlyArray<NavItem>;
  /** Roster index for the selected company — opens the profile via ?focus=<id>. */
  contractors: ReadonlyArray<{ id: string; name: string }>;
  /** Pay periods for the selected company — opens the period via ?period=<start>. */
  periods: ReadonlyArray<{ id: string; label: string; start: string }>;
  onClose: () => void;
}

type Result =
  | { type: 'section'; key: string; label: string; sub: string; icon: string; href: string }
  | { type: 'worker'; key: string; label: string; sub: string; icon: string; id: string }
  | { type: 'period'; key: string; label: string; sub: string; icon: string; start: string };

const CAP = 14;

/**
 * Quick-find palette (⌘K / Ctrl-K) — faithful port of the legacy CommandPalette.
 * Filters sections + contractors + periods client-side; ArrowUp/Down moves the
 * selection, Enter navigates (appending ?focus=<id> for contractors and
 * ?period=<start> for periods), Esc closes. Built on the shared Modal so it
 * inherits the focus-trap + restore + backdrop-close behaviour.
 */
export const CommandPalette = ({
  sections,
  contractors,
  periods,
  onClose,
}: CommandPaletteProps) => {
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const ql = q.trim().toLowerCase();

  const results = useMemo<Result[]>(() => {
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Result[] = [];
    for (const s of sections) {
      if (match(s.label)) {
        out.push({
          type: 'section',
          key: `section:${s.href}`,
          label: s.label,
          sub: 'Section',
          icon: s.icon,
          href: s.href,
        });
      }
    }
    for (const w of contractors.filter((c) => match(c.name)).slice(0, 8)) {
      out.push({
        type: 'worker',
        key: `worker:${w.id}`,
        label: w.name || '(no name)',
        sub: 'Contractor',
        icon: '👤',
        id: w.id,
      });
    }
    for (const p of periods.filter((p) => match(`${p.label} ${p.start}`)).slice(0, 8)) {
      out.push({
        type: 'period',
        key: `period:${p.id}`,
        label: p.label,
        sub: 'Period',
        icon: '📅',
        start: p.start,
      });
    }
    return out.slice(0, CAP);
  }, [ql, sections, contractors, periods]);

  const selIdx = Math.min(sel, Math.max(0, results.length - 1));

  // Keep the active row scrolled into view as the selection moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only selIdx drives the scroll
  useEffect(() => {
    const el = listRef.current?.querySelector('.cmdk-item.sel');
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ block: 'nearest' });
  }, [selIdx]);

  const activate = (it: Result | undefined) => {
    if (!it) return;
    onClose();
    if (it.type === 'section') router.push(it.href);
    else if (it.type === 'worker') router.push(`/contractors?focus=${encodeURIComponent(it.id)}`);
    else router.push(`/payroll?period=${encodeURIComponent(it.start)}`);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(results[selIdx]);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div className="cmdk" style={{ padding: 0 }}>
        <input
          className="cmdk-input"
          // biome-ignore lint/a11y/noAutofocus: palette is a transient command surface; focus is expected.
          autoFocus
          value={q}
          onKeyDown={onKey}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          placeholder="Search contractors, periods, sections…"
          aria-label="Quick find"
        />
        <div className="cmdk-list" ref={listRef} aria-label="Results">
          {results.length === 0 && <div className="cmdk-empty">No matches</div>}
          {results.map((it, i) => (
            <button
              key={it.key}
              type="button"
              className={i === selIdx ? 'cmdk-item sel' : 'cmdk-item'}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(it)}
            >
              <span className="cmdk-ico" aria-hidden="true">
                {it.icon}
              </span>
              <span className="cmdk-label">{it.label}</span>
              <span className="cmdk-type">{it.sub}</span>
            </button>
          ))}
        </div>
        <div className="cmdk-foot">↑↓ navigate · ↵ open · esc close</div>
      </div>
    </Modal>
  );
};
