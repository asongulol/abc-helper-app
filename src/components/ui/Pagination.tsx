'use client';

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
  onPage: (p: number) => void;
  /** Plural noun for the count, e.g. "invoices". */
  noun?: string;
}

/** "Showing X–Y of Z · ‹ Prev · Page n/m · Next ›" footer for a paginated table. */
export const Pagination = ({
  page,
  totalPages,
  total,
  from,
  to,
  onPage,
  noun = 'rows',
}: PaginationProps) => {
  if (total === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
        flexWrap: 'wrap',
      }}
    >
      <span className="sub">
        Showing {from}–{to} of {total} {noun}
      </span>
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            className="btn ghost sm"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            aria-label="Previous page"
          >
            ‹ Prev
          </button>
          <span className="sub">
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            aria-label="Next page"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
};
