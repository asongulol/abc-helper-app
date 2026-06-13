'use client';

import { type ReactNode, useMemo, useState } from 'react';

export interface SortableColumn<T> {
  key: string;
  label: string;
  /** Show the sort affordance + make the header clickable. */
  sortable?: boolean;
  /** Custom cell renderer; defaults to the accessor value as text. */
  render?: (row: T) => ReactNode;
  /**
   * Sort/filter value for this column. Defaults to `row[key]` when the key is
   * a property of the row.
   */
  accessor?: (row: T) => string | number | null | undefined;
  /** Mobile card-stack: render this cell as the card's title row. */
  cardTitle?: boolean;
}

export interface SortableTableProps<T> {
  columns: ReadonlyArray<SortableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string | number;
  /** Show the text filter box (legacy FilterBox). Default true. */
  filterable?: boolean;
  filterPlaceholder?: string;
  /** Shown when there are no rows (after filtering). */
  emptyMessage?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Keep tabular layout on phones (side-scroll) instead of the card stack. */
  keepTable?: boolean;
}

type SortDir = 1 | -1;

const defaultAccessor = <T,>(col: SortableColumn<T>) => {
  if (col.accessor) return col.accessor;
  return (row: T): string | number | null | undefined => {
    const v = (row as Record<string, unknown>)[col.key];
    if (v == null || typeof v === 'string' || typeof v === 'number') {
      return v as string | number | null | undefined;
    }
    return String(v);
  };
};

/** Legacy useSortFilter comparator: nulls last; numeric when both numbers. */
const compareValues = (
  x: string | number | null | undefined,
  y: string | number | null | undefined,
  dir: SortDir,
): number => {
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
  return String(x).localeCompare(String(y)) * dir;
};

/**
 * Generic sortable + filterable table — port of the legacy `useSortFilter`
 * hook and table markup: click a header to sort (▲/▼, ⇅ when unsorted; first
 * click ascending, second flips), text filter across column values, sticky
 * header (within .table-scroll), hover rows, and the CSS-driven card-stack on
 * small screens via per-cell `data-label` attributes.
 */
export const SortableTable = <T,>({
  columns,
  rows,
  rowKey,
  filterable = true,
  filterPlaceholder = 'Filter…',
  emptyMessage = 'Nothing here yet.',
  onRowClick,
  keepTable = false,
}: SortableTableProps<T>) => {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<SortDir>(1);
  const [q, setQ] = useState('');

  const toggle = (key: string) => {
    if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(1);
    }
  };

  const visible = useMemo(() => {
    let out: T[] = [...rows];
    if (filterable && q) {
      const needle = q.toLowerCase();
      out = out.filter((row) =>
        columns.some((col) => {
          const v = defaultAccessor(col)(row);
          return v != null && String(v).toLowerCase().includes(needle);
        }),
      );
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        const acc = defaultAccessor(col);
        out = [...out].sort((a, b) => compareValues(acc(a), acc(b), dir));
      }
    }
    return out;
  }, [rows, columns, filterable, q, sortKey, dir]);

  const indicator = (col: SortableColumn<T>): string => {
    if (!col.sortable) return '';
    if (sortKey === col.key) return dir === 1 ? ' ▲' : ' ▼';
    return ' ⇅';
  };

  return (
    <div>
      {filterable && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={filterPlaceholder}
          aria-label={filterPlaceholder}
          style={{ maxWidth: 240, marginBottom: 10 }}
        />
      )}
      {visible.length === 0 ? (
        <div className="empty">{q ? 'No matches for your filter.' : emptyMessage}</div>
      ) : (
        <div className={keepTable ? 'table-scroll keep-table' : 'table-scroll'}>
          <table>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    aria-sort={
                      sortKey === col.key ? (dir === 1 ? 'ascending' : 'descending') : undefined
                    }
                    style={{ userSelect: 'none' }}
                  >
                    {col.sortable ? (
                      // IMPROVED: a real button (keyboard-sortable) vs the legacy th onClick.
                      <button type="button" className="th-sort" onClick={() => toggle(col.key)}>
                        {col.label}
                        {indicator(col)}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: row click is a convenience; primary actions live in cells.
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? 'clickable' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-label={col.label}
                      className={col.cardTitle ? 'card-title' : undefined}
                    >
                      {col.render ? col.render(row) : (defaultAccessor(col)(row) ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
