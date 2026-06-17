'use client';

import { useEffect, useRef, useState } from 'react';

export interface ContractorPickerProps {
  options: ReadonlyArray<{ id: string; name: string }>;
  /** Selected ids. Treated as immutable — `onChange` always receives a new Set. */
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  placeholder?: string | undefined;
}

/**
 * Searchable multi-select popover over contractors — faithful port of the legacy
 * ContractorPicker. Select-all / clear, outside-click + Escape to close. Uses the
 * shared `.cpick` CSS classes.
 */
export const ContractorPicker = ({
  options,
  value,
  onChange,
  placeholder,
}: ContractorPickerProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = options.filter((o) => o.name.toLowerCase().includes(needle));
  const allOn = options.length > 0 && value.size === options.length;
  const toggle = (id: string) => {
    const n = new Set(value);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onChange(n);
  };
  const summary =
    value.size === 0
      ? (placeholder ?? 'Select…')
      : allOn
        ? 'All contractors'
        : `${value.size} selected`;

  return (
    <div className="cpick" ref={ref}>
      <button
        type="button"
        className="btn ghost sm cpick-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{summary}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="cpick-menu" role="dialog" aria-label="Choose contractors">
          <input
            className="cpick-search"
            // biome-ignore lint/a11y/noAutofocus: popover search field is the expected first focus.
            autoFocus
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search contractors"
          />
          <div className="cpick-row">
            <button
              type="button"
              className="btn ghost sm"
              disabled={!options.length}
              onClick={() => onChange(new Set(options.map((o) => o.id)))}
            >
              Select all ({options.length})
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={!value.size}
              onClick={() => onChange(new Set())}
            >
              Clear
            </button>
          </div>
          <div className="cpick-list">
            {filtered.length === 0 ? (
              <div className="muted" style={{ padding: 8, fontSize: 12 }}>
                No matches
              </div>
            ) : (
              filtered.map((o) => (
                <label key={o.id} className="cpick-item">
                  <input type="checkbox" checked={value.has(o.id)} onChange={() => toggle(o.id)} />
                  <span>{o.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
